import { storage } from "@/src/utils/storage";

const MAC_KEY = "iptv_device_mac";
const PIN_KEY = "iptv_device_pin";

function randomMac() {
  const hex = "0123456789ABCDEF";
  return Array.from({ length: 6 }, () => hex[Math.floor(Math.random() * 16)] + hex[Math.floor(Math.random() * 16)]).join(":");
}

export interface Identity {
  mac: string;
  pin: string;
}

let cached: Identity | null = null;

export async function getIdentity(): Promise<Identity> {
  if (cached) return cached;
  let mac = await storage.getItem(MAC_KEY, null);
  let pin = await storage.getItem(PIN_KEY, null);
  if (typeof mac !== "string" || typeof pin !== "string") {
    mac = randomMac();
    pin = String(Math.floor(100000 + Math.random() * 900000));
    await storage.setItem(MAC_KEY, mac);
    await storage.setItem(PIN_KEY, pin);
  }
  cached = { mac, pin };
  return cached;
}
