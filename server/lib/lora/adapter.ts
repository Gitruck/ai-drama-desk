import type { LoraCheckpoint, LoraJob, LoraManifest, LoraTrainRequest } from "../../../shared/contracts/index.ts";

export interface TrainerCommand {
  cmd: string[];
  cwd: string;
  env?: Record<string, string>;
}

export interface TrainerProgress {
  localStep: number;
  totalLocalSteps: number;
  loss?: number;
}

export interface TrainerAdapter {
  id: string;
  validate(request: LoraTrainRequest): Promise<string[]>;
  buildCommand(request: LoraTrainRequest): TrainerCommand;
  parseProgress(text: string): TrainerProgress | null;
  discoverCheckpoints(job: LoraJob): LoraCheckpoint[];
  createManifest(job: LoraJob): Promise<LoraManifest | null>;
}

