import type { Channel } from "@/src/api";

// In-memory list the player uses for next/previous channel.
export const playQueue: { items: Channel[]; index: number } = { items: [], index: 0 };
