import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { LoraCheckpoint, LoraJob, LoraManifest, LoraTrainRequest } from "../../../shared/contracts/index.ts";
import type { TrainerAdapter, TrainerCommand, TrainerProgress } from "./adapter.ts";

function localTrainSteps(request: LoraTrainRequest): number {
  return Math.max(1, request.maxTrainSteps - (request.completedStepsBeforeResume ?? 0));
}

function checkpointStep(name: string): number | null {
  const match = name.match(/-step0*(\d+)(?:-state)?(?:\.safetensors)?$/i);
  return match ? Number(match[1]) : null;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export class MusubiQwenImageAdapter implements TrainerAdapter {
  id = "musubi-qwen-image-edit";

  async validate(request: LoraTrainRequest): Promise<string[]> {
    const required: Array<[string, string]> = [
      ["python", request.pythonPath],
      ["trainerRoot", request.trainerRoot],
      ["datasetConfig", request.datasetConfig],
      ["baseModel", request.baseModel],
      ["vae", request.vaePath],
      ["textEncoder", request.textEncoderPath],
    ];
    const missing = required.filter(([, path]) => !existsSync(resolve(path))).map(([name, path]) => `${name}: ${basename(path)}`);
    const script = join(resolve(request.trainerRoot), "src", "musubi_tuner", "qwen_image_train_network.py");
    if (!existsSync(script)) missing.push("trainer script: src/musubi_tuner/qwen_image_train_network.py");
    if (request.resumeFrom && !existsSync(resolve(request.resumeFrom))) missing.push(`resume checkpoint: ${basename(request.resumeFrom)}`);
    return missing;
  }

  buildCommand(request: LoraTrainRequest): TrainerCommand {
    const steps = localTrainSteps(request);
    const cmd = [
      resolve(request.pythonPath),
      "-m", "accelerate.commands.launch",
      "--num_cpu_threads_per_process", "1",
      "--mixed_precision", "bf16",
      "src/musubi_tuner/qwen_image_train_network.py",
      "--dit", resolve(request.baseModel),
      "--vae", resolve(request.vaePath),
      "--text_encoder", resolve(request.textEncoderPath),
      "--model_version", "edit-2511",
      "--dataset_config", resolve(request.datasetConfig),
      "--sdpa", "--mixed_precision", "bf16", "--fp8_base", "--fp8_scaled",
      "--blocks_to_swap", String(request.blocksToSwap ?? 24),
      "--timestep_sampling", "shift", "--weighting_scheme", "none", "--discrete_flow_shift", "2.2",
      "--optimizer_type", "adamw8bit", "--learning_rate", String(request.learningRate ?? 1e-4),
      "--gradient_checkpointing", "--max_data_loader_n_workers", "2", "--persistent_data_loader_workers",
      "--network_module", "networks.lora_qwen_image",
      "--network_dim", String(request.networkDim ?? 32),
      "--network_alpha", String(request.networkAlpha ?? 16),
      "--max_train_steps", String(steps),
      "--save_every_n_steps", String(request.saveEveryNSteps ?? 100),
      "--save_state", "--seed", "42",
      "--output_dir", resolve(request.outputDir),
      "--output_name", request.outputName,
    ];
    if (request.resumeFrom) cmd.push("--resume", resolve(request.resumeFrom));
    cmd.push(...(request.extraArgs ?? []));
    return { cmd, cwd: resolve(request.trainerRoot) };
  }

  parseProgress(text: string): TrainerProgress | null {
    const matches = [...text.matchAll(/steps:\s*\d+%[^\r\n]*?\|\s*(\d+)\/(\d+)[^\r\n]*?(?:avr_loss=([0-9.eE+-]+))?/g)];
    const match = matches.at(-1);
    if (!match) return null;
    return { localStep: Number(match[1]), totalLocalSteps: Number(match[2]), ...(match[3] ? { loss: Number(match[3]) } : {}) };
  }

  discoverCheckpoints(job: LoraJob): LoraCheckpoint[] {
    const dir = resolve(job.request.outputDir);
    if (!existsSync(dir)) return [];
    const before = job.request.completedStepsBeforeResume ?? 0;
    const stateByStep = new Map<number, string>();
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      if (!item.isDirectory() || !item.name.startsWith(`${job.request.outputName}-step`) || !item.name.endsWith("-state")) continue;
      const local = checkpointStep(item.name);
      if (local != null) stateByStep.set(before + local, join(dir, item.name));
    }
    return readdirSync(dir, { withFileTypes: true })
      .filter((x) => x.isFile() && x.name.startsWith(`${job.request.outputName}-step`) && x.name.endsWith(".safetensors"))
      .map((x) => {
        const local = checkpointStep(x.name)!;
        const step = before + local;
        return { step, path: join(dir, x.name), statePath: stateByStep.get(step), createdAt: statSync(join(dir, x.name)).mtime.toISOString() };
      })
      .filter((x) => Number.isFinite(x.step))
      .sort((a, b) => a.step - b.step);
  }

  async createManifest(job: LoraJob): Promise<LoraManifest | null> {
    const final = join(resolve(job.request.outputDir), `${job.request.outputName}.safetensors`);
    const fallback = this.discoverCheckpoints(job).at(-1)?.path;
    const weightsPath = existsSync(final) ? final : fallback;
    if (!weightsPath) return null;
    return {
      schemaVersion: "gitruck.style-lora/v1",
      adapter: this.id,
      baseModel: resolve(job.request.baseModel),
      weightsPath,
      sha256: sha256(weightsPath),
      triggerWords: job.request.triggerWords ?? [],
      license: job.request.license,
      trainedAt: new Date().toISOString(),
      training: {
        maxTrainSteps: job.request.maxTrainSteps,
        learningRate: job.request.learningRate ?? 1e-4,
        networkDim: job.request.networkDim ?? 32,
        networkAlpha: job.request.networkAlpha ?? 16,
        blocksToSwap: job.request.blocksToSwap ?? 24,
      },
    };
  }
}

