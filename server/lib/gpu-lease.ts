export type GpuLeaseKind = "generation" | "lora";

export interface GpuLease {
  kind: GpuLeaseKind;
  ownerId: string;
  acquiredAt: number;
}

let current: GpuLease | null = null;

export function getGpuLease(): GpuLease | null {
  return current ? { ...current } : null;
}

export function tryAcquireGpu(kind: GpuLeaseKind, ownerId: string): boolean {
  if (current && (current.kind !== kind || current.ownerId !== ownerId)) return false;
  current = current ?? { kind, ownerId, acquiredAt: Date.now() };
  return true;
}

export function releaseGpu(ownerId: string): void {
  if (current?.ownerId === ownerId) current = null;
}

export function resetGpuLeaseForTests(): void {
  current = null;
}

