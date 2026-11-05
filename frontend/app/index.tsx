import { BlurView } from "expo-blur";
import { Image } from "expo-image";
import { LinearGradient } from "expo-linear-gradient";
import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import Animated, { FadeInDown, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, DeviceState, DeviceStatus } from "@/src/api";
import { getIdentity, Identity } from "@/src/device";
import { makeStyles, ThemeColors, useTheme } from "@/src/theme";

const BG = "https://images.unsplash.com/photo-1478760329108-5c3ed9d495a0?crop=entropy&cs=srgb&fm=jpg&q=85&w=1200";
const POLL_MS = 4000;

function statusInfo(s: DeviceState | null, c: ThemeColors): { label: string; color: string } {
  switch (s) {
    case "active": return { label: "Lista ativa", color: c.success };
    case "expired": return { label: "Lista expirada", color: c.error };
    case "blocked": return { label: "Dispositivo bloqueado", color: c.error };
    case "wrong_pin": return { label: "Senha não confere", color: c.error };
    case "no_list": return { label: "Sem lista vinculada", color: c.warning };
    case "offline": return { label: "Sem conexão", color: c.warning };
    case "pending": return { label: "Aguardando ativação", color: c.warning };
    default: return { label: "Verificando...", color: c.info };
  }
}

function formatDate(iso?: string | null) {
  if (!iso) return null;
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

export default function Activation() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [id, setId] = useState<Identity | null>(null);
  const [status, setStatus] = useState<DeviceStatus | null>(null);
  const navigated = useRef(false);
  const pulse = useSharedValue(1);

  useEffect(() => {
    pulse.value = withRepeat(withTiming(0.3, { duration: 900 }), -1, true);
    getIdentity().then(setId);
  }, [pulse]);

  useEffect(() => {
    if (!id) return;
    let alive = true;
    const check = async () => {
      try {
        const s = await api.status(id.mac, id.pin);
        if (!alive) return;
        setStatus(s);
        if (s.state === "active" && !navigated.current) {
          navigated.current = true;
          setTimeout(() => router.replace("/browser"), 1200);
        }
      } catch {
        if (alive) setStatus({ state: "offline" });
      }
    };
    check();
    const t = setInterval(check, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [id, router]);

  const dotStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));
  const info = statusInfo(status?.state ?? null, colors);
  const expiry = formatDate(status?.expiry);

  return (
    <View style={styles.root} testID="activation-screen">
      <Image source={{ uri: BG }} style={styles.bg} contentFit="cover" />
      <LinearGradient colors={["transparent", colors.scrim, colors.surface]} style={styles.bg} />
      <View style={[styles.center, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
        <Animated.View entering={FadeInDown.duration(600)} style={styles.cardWrap}>
          <BlurView intensity={40} tint="dark" style={styles.card}>
            <Text style={styles.label}>Endereço MAC</Text>
            {id ? (
              <Text style={styles.mac} testID="device-mac" selectable adjustsFontSizeToFit numberOfLines={1}>{id.mac}</Text>
            ) : (
              <ActivityIndicator color={colors.onSurface} />
            )}
            <View style={styles.divider} />
            <Text style={styles.label}>Senha</Text>
            <Text style={styles.pin} testID="device-pin" selectable>{id?.pin ?? "------"}</Text>
            <View style={styles.divider} />
            <Text style={styles.label}>Status da lista</Text>
            <View style={styles.statusRow} testID="list-status">
              <Animated.View style={[styles.dot, { backgroundColor: info.color }, status?.state === "active" ? null : dotStyle]} />
              <Text style={[styles.status, { color: info.color }]} testID="list-status-text">{info.label}</Text>
            </View>
            {expiry ? <Text style={styles.expiry} testID="list-expiry">Válida até {expiry}</Text> : null}
          </BlurView>
        </Animated.View>
      </View>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  bg: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  center: { flex: 1, justifyContent: "center", paddingHorizontal: 24 },
  cardWrap: { width: "100%", maxWidth: 440, alignSelf: "center", borderRadius: 20, overflow: "hidden", borderWidth: 1, borderColor: c.borderStrong },
  card: { padding: 24, backgroundColor: c.glass },
  label: { color: c.muted, fontSize: 12, letterSpacing: 2, textTransform: "uppercase", fontWeight: "600", marginBottom: 8 },
  mac: { color: c.onSurface, fontSize: 24, fontWeight: "800", letterSpacing: 1, fontVariant: ["tabular-nums"] },
  pin: { color: c.brandPrimary, fontSize: 36, fontWeight: "800", letterSpacing: 8, fontVariant: ["tabular-nums"] },
  divider: { height: 1, backgroundColor: c.border, marginVertical: 24 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  dot: { width: 12, height: 12, borderRadius: 6 },
  status: { fontSize: 20, fontWeight: "700" },
  expiry: { color: c.onSurfaceTertiary, fontSize: 14, marginTop: 8 },
}));
