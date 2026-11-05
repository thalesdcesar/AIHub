import type { VideoSource } from "expo-video";

import type { Channel } from "@/src/api";

// Many IPTV servers reject unknown players; a VLC user agent is widely accepted.
const HEADERS = { "User-Agent": "VLC/3.0.20 LibVLC/3.0.20" };

function typeFor(url: string): "hls" | "progressive" | "auto" {
  const path = url.toLowerCase().split("?")[0];
  if (path.endsWith(".m3u8") || path.endsWith(".m3u")) return "hls";
  if (/\.(mp4|mkv|avi|mov|m4v|ts|mp3|aac)$/.test(path)) return "progressive";
  return "auto";
}

// Ordered list of sources to try. Xtream-style live links (host/user/pass/ID.ts)
// are tried as HLS first (.m3u8): raw endless .ts stalls on Android and never
// plays on iOS, which is what caused the infinite loading.
export function streamCandidates(ch: Channel): VideoSource[] {
  const urls: string[] = [];
  const isVod = ch.section === "movies" || ch.section === "series";
  const m = ch.url.match(/^(https?:\/\/[^/]+)\/(?:live\/)?([^/]+)\/([^/]+)\/(\d+)(?:\.(ts|m3u8))?(\?.*)?$/i);
  if (m && !isVod) {
    const [, host, user, pass, id] = m;
    urls.push(`${host}/live/${user}/${pass}/${id}.m3u8`);
    urls.push(ch.url);
    urls.push(`${host}/live/${user}/${pass}/${id}.ts`);
  } else {
    urls.push(ch.url);
  }
  return Array.from(new Set(urls)).map((uri) => ({ uri, headers: HEADERS, contentType: typeFor(uri) }));
}
