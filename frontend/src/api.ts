const BASE = `${process.env.EXPO_PUBLIC_BACKEND_URL}/api`;

export type DeviceState = "pending" | "wrong_pin" | "blocked" | "expired" | "no_list" | "active" | "offline";
export type Section = "tv" | "movies" | "series" | "music";

export interface DeviceStatus {
  state: DeviceState;
  expiry?: string | null;
  name?: string | null;
}

export interface Channel {
  id: number;
  name: string;
  logo: string | null;
  group: string;
  section: Section;
  url: string;
}

export interface Summary {
  state: "loading" | "ready" | "error";
  error?: string | null;
  progress?: number;
  total?: number;
  counts?: Record<Section, number>;
  groups?: Record<Section, { name: string; count: number }[]>;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function get<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
  const qs = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join("&");
  const res = await fetch(`${BASE}${path}?${qs}`);
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

export const api = {
  status: (mac: string, pin: string) => get<DeviceStatus>("/device/status", { mac, pin }),
  summary: (mac: string, pin: string, refresh = false) =>
    get<Summary>("/playlist/summary", { mac, pin, refresh: refresh ? "true" : undefined }),
  channels: (p: { mac: string; pin: string; section: Section; group?: string; q?: string; offset: number }) =>
    get<{ state: string; items: Channel[]; total: number }>("/playlist/channels", { ...p, limit: 60 }),
};
