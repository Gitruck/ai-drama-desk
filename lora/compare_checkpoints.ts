import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 抽卡对比脚本的可覆盖参数：COMFY_URL / LORA_TRIGGER / LORA_COMPARE_DIR 环境变量，
// 或直接改下面的 variants 配置块（LoRA 文件名换成你自己的 checkpoint）。
const comfyBaseUrl = process.env.COMFY_URL ?? "http://127.0.0.1:8188";
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = join(projectRoot, "templates", "qwen-edit-keyframe.json");
const outputDirectory = process.env.LORA_COMPARE_DIR ?? join(projectRoot, "lora", "comparisons", "checkpoint-compare");
const trigger = process.env.LORA_TRIGGER ?? "example style";
const prompt =
  `${trigger}, a young female astronaut kneeling in a quiet greenhouse on Mars, gently watering a small tomato plant, curved glass dome, red desert and two moons outside, full body, wide composition, clean linework, soft flat colors, abundant negative space, quiet tender everyday emotion`;
const negativePrompt =
  "photorealistic, 3D render, glossy CGI, neon colors, high contrast, dark black background, text, watermark, logo, duplicate person, extra limbs, extra fingers, malformed hands, blurry, low quality";
const seed = 42_424_242;
const strength = 0.9;

// LoRA 名是 ComfyUI models/loras/ 下的相对路径，换成你自己的 checkpoint 序列。
const variants = [
  { label: "00-base-no-lora", lora: null, cumulativeSteps: 0 },
  {
    label: "01-cum0300-s0.9",
    lora: "example-style-compare\\example-style-cum0300.safetensors",
    cumulativeSteps: 300,
  },
  {
    label: "02-cum0600-s0.9",
    lora: "example-style-compare\\example-style-cum0600.safetensors",
    cumulativeSteps: 600,
  },
  {
    label: "03-cum1200-s0.9",
    lora: "example-style-compare\\example-style-cum1200.safetensors",
    cumulativeSteps: 1_200,
  },
  {
    label: "04-cum1800-s0.9",
    lora: "example-style-compare\\example-style-cum1800.safetensors",
    cumulativeSteps: 1_800,
  },
  {
    label: "05-cum2304-final-s0.9",
    lora: "example-style-compare\\example-style-cum2304-final.safetensors",
    cumulativeSteps: 2_304,
  },
] as const;

type ComfyImage = {
  filename: string;
  subfolder?: string;
  type?: string;
};

type RunResult = (typeof variants)[number] & {
  strength: number;
  seed: number;
  promptId: string;
  queuedAt: string;
  finishedAt: string;
  elapsedSeconds: number;
  images: string[];
};

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init);
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${text}`);
  }
  return payload;
}

async function runVariant(
  template: Record<string, any>,
  variant: (typeof variants)[number],
  index: number,
  results: RunResult[],
) {
  const workflow = structuredClone(template);
  workflow["6"].inputs.prompt = prompt;
  workflow["7"].inputs.prompt = negativePrompt;
  workflow["14"].inputs.width = 1_024;
  workflow["14"].inputs.height = 1_024;
  workflow["15"].inputs.seed = seed;
  workflow["17"].inputs.filename_prefix = `aidrama/lora-compare/${variant.label}`;

  if (variant.lora) {
    workflow["18"] = {
      class_type: "LoraLoaderModelOnly",
      inputs: {
        model: ["1", 0],
        lora_name: variant.lora,
        strength_model: strength,
      },
    };
    workflow["13"].inputs.model = ["18", 0];
  }

  await Bun.write(
    join(outputDirectory, `${variant.label}.workflow.json`),
    JSON.stringify(workflow, null, 2),
  );

  const queuedAt = new Date().toISOString();
  const queued = await fetchJson(`${comfyBaseUrl}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      prompt: workflow,
      client_id: "gitruck-lora-checkpoint-compare",
    }),
  });
  if (!queued.prompt_id) {
    throw new Error(`ComfyUI did not return prompt_id: ${JSON.stringify(queued)}`);
  }

  const promptId = queued.prompt_id as string;
  const startedAt = Date.now();
  let lastProgressAt = 0;
  console.log(`[${index + 1}/${variants.length}] queued ${variant.label}: ${promptId}`);

  while (Date.now() - startedAt < 20 * 60 * 1_000) {
    await Bun.sleep(2_000);
    const history = await fetchJson(`${comfyBaseUrl}/history/${promptId}`);
    const item = history[promptId];
    if (!item) continue;

    if (item.status?.status_str === "error") {
      throw new Error(
        `Execution failed for ${variant.label}: ${JSON.stringify(item.status.messages)}`,
      );
    }

    if (item.status?.completed) {
      const images = Object.values(item.outputs ?? {}).flatMap(
        (output: any) => (output.images ?? []) as ComfyImage[],
      );
      if (images.length === 0) {
        throw new Error(`No image output for ${variant.label}`);
      }

      const savedImages: string[] = [];
      for (const [imageIndex, image] of images.entries()) {
        const query = new URLSearchParams({
          filename: image.filename,
          subfolder: image.subfolder ?? "",
          type: image.type ?? "output",
        });
        const response = await fetch(`${comfyBaseUrl}/view?${query}`);
        if (!response.ok) {
          throw new Error(`Image download failed: ${response.status} ${response.statusText}`);
        }
        const suffix = images.length === 1 ? "" : `-${imageIndex + 1}`;
        const destination = join(outputDirectory, `${variant.label}${suffix}.png`);
        await Bun.write(destination, await response.arrayBuffer());
        savedImages.push(destination.replaceAll("\\", "/"));
      }

      const result: RunResult = {
        ...variant,
        strength: variant.lora ? strength : 0,
        seed,
        promptId,
        queuedAt,
        finishedAt: new Date().toISOString(),
        elapsedSeconds: Math.round((Date.now() - startedAt) / 1_000),
        images: savedImages,
      };
      results.push(result);
      await Bun.write(
        join(outputDirectory, "run.json"),
        JSON.stringify(
          {
            baseModel: template["1"].inputs.unet_name,
            prompt,
            negativePrompt,
            seed,
            width: 1_024,
            height: 1_024,
            variants: results,
          },
          null,
          2,
        ),
      );
      console.log(
        `[${index + 1}/${variants.length}] completed ${variant.label} in ${result.elapsedSeconds}s -> ${savedImages.join(", ")}`,
      );
      return;
    }

    if (Date.now() - lastProgressAt >= 15_000) {
      const queue = await fetchJson(`${comfyBaseUrl}/queue`);
      console.log(
        `[${index + 1}/${variants.length}] ${variant.label} running ${Math.round((Date.now() - startedAt) / 1_000)}s (active=${queue.queue_running?.length ?? 0}, pending=${queue.queue_pending?.length ?? 0})`,
      );
      lastProgressAt = Date.now();
    }
  }

  throw new Error(`Timed out waiting for ${variant.label}`);
}

mkdirSync(outputDirectory, { recursive: true });
const template = (await Bun.file(templatePath).json()) as Record<string, any>;
const results: RunResult[] = [];

for (const [index, variant] of variants.entries()) {
  await runVariant(template, variant, index, results);
}

console.log(`ALL_DONE ${outputDirectory}`);
