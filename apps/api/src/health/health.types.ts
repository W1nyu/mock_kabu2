export type DependencyHealthStatus = "up" | "down";
export type WorkerHealthStatus = DependencyHealthStatus | "degraded" | "unknown";

export interface DependencyHealth {
  status: DependencyHealthStatus;
  latencyMs: number;
  /** Deliberately terse so readiness responses do not leak connection details. */
  error?: string;
}

export interface WorkerHealth {
  status: WorkerHealthStatus;
  ttlMs?: number;
  /** Number of financial stream events being retained for retry, if reported. */
  retainedEventCount?: number;
  lastFailureAt?: string;
  error?: string;
}

export interface HealthWorkerProbe {
  check(): Promise<Record<string, WorkerHealth>>;
}

export interface LivenessReport {
  status: "ok";
  service: "api";
  timestamp: string;
}

export interface ReadinessReport {
  status: "ok" | "error";
  service: "api";
  timestamp: string;
  dependencies: {
    database: DependencyHealth;
    redis: DependencyHealth;
  };
  /** Worker state is informative and does not gate API traffic readiness. */
  workers: Record<string, WorkerHealth>;
}
