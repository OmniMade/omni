import { hostSummarySchema, httpToWs, type HostSummary } from "@omni/aep";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface MeInfo {
  id: string;
  username: string;
  createdAt: string;
}

export interface EnrollmentInfo {
  token: string;
  expiresAt: string;
  command: string;
}

/**
 * Typed REST client for the Omni control plane. Cookies travel with the
 * browser's fetch automatically; Node callers can pass a cookie-stamping
 * fetch wrapper.
 */
export class OmniClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchFn: FetchLike = (input, init) => fetch(input, init),
  ) {}

  async setup(input: { username: string; password: string }): Promise<MeInfo> {
    return this.#json("POST", "/api/v1/auth/setup", input) as Promise<MeInfo>;
  }

  async login(input: { username: string; password: string }): Promise<MeInfo> {
    return this.#json("POST", "/api/v1/auth/login", input) as Promise<MeInfo>;
  }

  async logout(): Promise<void> {
    await this.#json("POST", "/api/v1/auth/logout");
  }

  async me(): Promise<MeInfo | null> {
    try {
      return (await this.#json("GET", "/api/v1/auth/me")) as MeInfo;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  }

  async listHosts(): Promise<HostSummary[]> {
    const body = (await this.#json("GET", "/api/v1/hosts")) as { hosts: unknown };
    const parsed = hostSummarySchema.array().parse(body.hosts);
    return parsed;
  }

  async createHost(name: string): Promise<{ host: HostSummary; enrollment: EnrollmentInfo }> {
    return (await this.#json("POST", "/api/v1/hosts", { name })) as {
      host: HostSummary;
      enrollment: EnrollmentInfo;
    };
  }

  async renameHost(hostId: string, name: string): Promise<HostSummary> {
    const body = (await this.#json("PATCH", `/api/v1/hosts/${hostId}`, { name })) as { host: HostSummary };
    return hostSummarySchema.parse(body.host);
  }

  async rotateHostToken(hostId: string): Promise<{ host: HostSummary; enrollment: EnrollmentInfo }> {
    return (await this.#json("POST", `/api/v1/hosts/${hostId}/rotate-token`)) as {
      host: HostSummary;
      enrollment: EnrollmentInfo;
    };
  }

  async deleteHost(hostId: string): Promise<void> {
    await this.#json("DELETE", `/api/v1/hosts/${hostId}`);
  }

  /** Host-side exchange: one-time enrollment token → persistent credential. */
  async enroll(token: string): Promise<{ hostId: string; credential: string }> {
    return (await this.#json("POST", "/api/v1/hosts/enroll", { token })) as {
      hostId: string;
      credential: string;
    };
  }

  async #json(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.fetchFn(`${this.baseUrl}${path}`, {
      method,
      credentials: "include",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" } }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const errorBody = (await res.json().catch(() => null)) as
        | { error?: { code?: string; message?: string; details?: unknown } }
        | null;
      throw new ApiError(
        res.status,
        errorBody?.error?.code ?? "UNKNOWN",
        errorBody?.error?.message ?? res.statusText,
        errorBody?.error?.details,
      );
    }
    if (res.status === 204) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
}

export { httpToWs };
export type { HostSummary };
export { UiSocket } from "./ui-socket";
export type { WebSocketLike, SocketFactory } from "./ui-socket";
