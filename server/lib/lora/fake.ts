import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { LoraCheckpoint, LoraJob, LoraManifest, LoraTrainRequest } from "../../../shared/contracts/index.ts";
import type { TrainerAdapter, TrainerCommand, TrainerProgress } from "./adapter.ts";

export class FakeTrainerAdapter implements TrainerAdapter {
  id = "fake";
  async validate(): Promise<string[]> { return []; }

  buildCommand(request: LoraTrainRequest): TrainerCommand {
    const total = Math.max(1, request.maxTrainSteps - (request.completedStepsBeforeResume ?? 0));
    const delayArg = request.extraArgs?.find((x) => x.startsWith("--fake-delay-ms="));
    const delay = Number(delayArg?.split("=")[1] ?? 5);
    const failArg = request.extraArgs?.find((x) => x.startsWith("--fake-fail-at="));
    const failAt = Number(failArg?.split("=")[1] ?? 0);
    const out = resolve(request.outputDir);
    const outputName = request.outputName.replace(/[^a-zA-Z0-9_.-]/g, "_");
    const mid = Math.max(1, Math.floor(total / 2));
    const checkpoint = join(out, `${outputName}-step${String(mid).padStart(8, "0")}.safetensors`);
    const stateDir = join(out, `${outputName}-step${String(mid).padStart(8, "0")}-state`);
    const script = [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      `mkdirSync(${JSON.stringify(out)}, { recursive: true });`,
      `for (let i=1;i<=${total};i++){ await Bun.sleep(${Math.max(0, delay)}); console.error('steps:  '+Math.round(i/${total}*100)+'%| | '+i+'/${total} [00:00<00:00, avr_loss='+(0.1/i).toFixed(4)+']'); if(i===${failAt}){ console.error('simulated trainer failure at step '+i); process.exit(7); } if(i===${mid}){ writeFileSync(${JSON.stringify(checkpoint)}, 'fake-checkpoint'); mkdirSync(${JSON.stringify(stateDir)}, {recursive:true}); writeFileSync(${JSON.stringify(join(stateDir, "state.json"))}, '{}'); } }`,
      `writeFileSync(${JSON.stringify(join(out, `${outputName}.safetensors`))}, 'fake-lora');`,
    ].join("\n");
    return { cmd: [process.execPath, "-e", script], cwd: process.cwd() };
  }

  parseProgress(text: string): TrainerProgress | null {
    const matches = [...text.matchAll(/steps:\s*\d+%[^\r\n]*?\|\s*(\d+)\/(\d+)[^\r\n]*?avr_loss=([0-9.eE+-]+)/g)];
    const match = matches.at(-1);
    return match ? { localStep: Number(match[1]), totalLocalSteps: Number(match[2]), loss: Number(match[3]) } : null;
  }

  discoverCheckpoints(job: LoraJob): LoraCheckpoint[] {
    const dir = resolve(job.request.outputDir);
    if (!existsSync(dir)) return [];
    const before = job.request.completedStepsBeforeResume ?? 0;
    const files = readdirSync(dir);
    const checkpoints: LoraCheckpoint[] = files
      .map((name) => ({ name, match: name.match(new RegExp(`^${job.request.outputName.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}-step0*(\\d+)\\.safetensors$`)) }))
      .filter((x) => x.match)
      .map((x) => {
        const local = Number(x.match![1]);
        const statePath = join(dir, `${job.request.outputName}-step${String(local).padStart(8, "0")}-state`);
        return { step: before + local, path: join(dir, x.name), statePath: existsSync(statePath) ? statePath : undefined, createdAt: new Date().toISOString() };
      });
    const final = files.find((x) => x === `${job.request.outputName}.safetensors`);
    if (final) checkpoints.push({ step: job.request.maxTrainSteps, path: join(dir, final), createdAt: new Date().toISOString() });
    return checkpoints.sort((a, b) => a.step - b.step);
  }

  async createManifest(job: LoraJob): Promise<LoraManifest | null> {
    const weightsPath = join(resolve(job.request.outputDir), `${job.request.outputName}.safetensors`);
    if (!existsSync(weightsPath)) return null;
    return {
      schemaVersion: "gitruck.style-lora/v1",
      adapter: this.id,
      baseModel: job.request.baseModel,
      weightsPath,
      sha256: createHash("sha256").update(readFileSync(weightsPath)).digest("hex"),
      triggerWords: job.request.triggerWords ?? [],
      license: job.request.license,
      trainedAt: new Date().toISOString(),
      training: { maxTrainSteps: job.request.maxTrainSteps, fake: true },
    };
  }
}
