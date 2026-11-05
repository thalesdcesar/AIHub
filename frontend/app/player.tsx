import { Ionicons } from "@react-native-vector-icons/ionicons";
import { useEvent } from "expo";
import { BlurView } from "expo-blur";
import { useRouter } from "expo-router";
import { useVideoPlayer, VideoView } from "expo-video";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { playQueue } from "@/src/queue";
import { streamCandidates } from "@/src/streams";
import { makeStyles, useTheme } from "@/src/theme";

const START_TIMEOUT_MS = 15000; // max wait for a source to start before trying the next
const STALL_TIMEOUT_MS = 12000; // max buffering while playing before reconnecting

type Phase = "loading" | "playing" | "error";

export default function Player() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [index, setIndex] = useState(playQueue.index);
  const channel = playQueue.items[index];
  const [phase, setPhase] = useState<Phase>("loading");
  const [attempt, setAttempt] = useState(0); // bump to restart
  const [showControls, setShowControls] = useState(true);
  const candRef = useRef(0);
  const reconnects = useRef(0);
  const startTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const phaseRef = useRef<Phase>("loading");

  const player = useVideoPlayer(null, (p) => {
    p.loop = false;
    p.staysActiveInBackground = false;
  });

  const setP = (p: Phase) => { phaseRef.current = p; setPhase(p); };
  const clearTimers = () => {
    if (startTimer.current) clearTimeout(startTimer.current);
    if (stallTimer.current) clearTimeout(stallTimer.current);
    startTimer.current = stallTimer.current = null;
  };

  // `fresh` is false until the new source is attached, so events left over
  // from the previous channel are ignored. "Playing" means the clock actually moves.
  const fresh = useRef(false);
  const lastTime = useRef(-1);
  const lastProgressAt = useRef(0);
  const loadRef = useRef<(ci: number) => void>(() => {});

  const loadCandidate = useCallback(async (ci: number) => {
    if (!channel) return;
    const cands = streamCandidates(channel);
    clearTimers();
    fresh.current = false;
    lastTime.current = -1;
    if (ci >= cands.length) {
      player.pause();
      setP("error");
      return;
    }
    candRef.current = ci;
    setP("loading");
    startTimer.current = setTimeout(() => {
      if (phaseRef.current !== "playing" && candRef.current === ci) loadRef.current(ci + 1);
    }, START_TIMEOUT_MS);
    try {
      await player.replaceAsync(cands[ci]);
      if (candRef.current !== ci) return;
      fresh.current = true;
      player.play();
    } catch {
      if (candRef.current === ci) loadRef.current(ci + 1);
    }
  }, [channel, player]);
  loadRef.current = loadCandidate;

  useEffect(() => {
    reconnects.current = 0;
    loadCandidate(0);
    return clearTimers;
  }, [loadCandidate, attempt]);

  const { isPlaying } = useEvent(player, "playingChange", { isPlaying: player.playing });

  useEffect(() => {
    player.timeUpdateEventInterval = 1;
    const statusSub = player.addListener("statusChange", ({ status }) => {
      if (!fresh.current) return;
      if (status === "readyToPlay") player.play(); // a play() issued before the load may have been aborted
      else if (status === "error") loadRef.current(candRef.current + 1);
    });
    const timeSub = player.addListener("timeUpdate", ({ currentTime }) => {
      if (!fresh.current) return;
      if (lastTime.current >= 0 && currentTime > lastTime.current) {
        lastProgressAt.current = Date.now();
        if (phaseRef.current !== "playing") {
          clearTimers();
          setP("playing");
        }
      }
      lastTime.current = currentTime;
    });
    // Stall watchdog: playing but the clock stopped (and not paused by the user).
    const watchdog = setInterval(() => {
      // Loading a fresh source: keep nudging play() (a play() issued during the load may be aborted).
      if (phaseRef.current === "loading" && fresh.current) player.play();
      if (phaseRef.current !== "playing" || !player.playing) {
        lastProgressAt.current = Date.now();
        return;
      }
      if (Date.now() - lastProgressAt.current > STALL_TIMEOUT_MS) {
        lastProgressAt.current = Date.now();
        if (reconnects.current < 2) {
          reconnects.current += 1;
          loadRef.current(candRef.current);
        } else {
          loadRef.current(candRef.current + 1);
        }
      }
    }, 1000);
    return () => { statusSub.remove(); timeSub.remove(); clearInterval(watchdog); };
  }, [player]);

  const bumpControls = useCallback(() => {
    setShowControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setShowControls(false), 4000);
  }, []);

  const reallyPlaying = isPlaying && phase === "playing";

  useEffect(() => {
    if (reallyPlaying) bumpControls();
    else {
      // Keep controls visible while paused, loading or blocked.
      if (hideTimer.current) clearTimeout(hideTimer.current);
      setShowControls(true);
    }
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, [bumpControls, index, reallyPlaying]);

  const goBack = () => (router.canGoBack() ? router.back() : router.replace("/browser"));

  const go = (delta: number) => {
    const next = index + delta;
    if (next < 0 || next >= playQueue.items.length) return;
    playQueue.index = next;
    setIndex(next);
  };

  if (!channel) {
    return (
      <View style={styles.root}>
        <View style={styles.center}>
          <Text style={styles.errTitle}>Nenhum canal selecionado</Text>
          <Pressable testID="player-back-empty-button" style={styles.primaryBtn} onPress={goBack}>
            <Text style={styles.primaryBtnText}>Voltar</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.root} testID="player-screen">
      <Pressable style={styles.fill} onPress={() => (!reallyPlaying ? setShowControls(true) : showControls ? setShowControls(false) : bumpControls())} testID="player-surface">
        <VideoView player={player} style={styles.fill} contentFit="contain" nativeControls={false} allowsPictureInPicture={false} />
      </Pressable>

      {phase === "loading" ? (
        <View style={styles.overlay} pointerEvents="none" testID="player-loading">
          <ActivityIndicator size="large" color={colors.onSurface} />
          <Text style={styles.loadingText}>Sintonizando...</Text>
        </View>
      ) : null}

      {phase === "error" ? (
        <View style={[styles.overlay, styles.errorBg]} testID="player-error">
          <Ionicons name="alert-circle" size={44} color={colors.error} />
          <Text style={styles.errTitle}>Canal indisponível</Text>
          <Text style={styles.errText}>O servidor não respondeu. Verifique a conexão ou tente outro canal.</Text>
          <View style={styles.errActions}>
            <Pressable testID="player-retry-button" style={styles.primaryBtn} onPress={() => setAttempt((a) => a + 1)}>
              <Ionicons name="refresh" size={18} color={colors.onBrandPrimary} />
              <Text style={styles.primaryBtnText}>Tentar novamente</Text>
            </Pressable>
            {index < playQueue.items.length - 1 ? (
              <Pressable testID="player-error-next-button" style={styles.secondaryBtn} onPress={() => go(1)}>
                <Text style={styles.secondaryBtnText}>Próximo</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}

      {showControls ? (
        <>
          <View style={[styles.top, { paddingTop: insets.top + 8 }]}>
            <Pressable testID="player-back-button" hitSlop={8} style={styles.roundBtn} onPress={goBack}>
              <Ionicons name="chevron-back" size={24} color={colors.onSurface} />
            </Pressable>
            <View style={styles.topText}>
              <Text style={styles.chName} numberOfLines={1} testID="player-channel-name">{channel.name}</Text>
              <Text style={styles.chGroup} numberOfLines={1}>{channel.group}</Text>
            </View>
          </View>
          <View style={[styles.bottomWrap, { bottom: insets.bottom + 16 }]}>
            <BlurView intensity={40} tint="dark" style={styles.bottom}>
              <Pressable testID="player-prev-button" hitSlop={8} style={styles.ctrl} disabled={index === 0} onPress={() => go(-1)}>
                <Ionicons name="play-skip-back" size={26} color={index === 0 ? colors.muted : colors.onSurface} />
              </Pressable>
              <Pressable
                testID="player-play-pause-button"
                style={styles.playBtn}
                onPress={() => { if (reallyPlaying) { player.pause(); } else { player.play(); } }}
              >
                <Ionicons name={reallyPlaying ? "pause" : "play"} size={30} color={colors.onBrandPrimary} />
              </Pressable>
              <Pressable testID="player-next-button" hitSlop={8} style={styles.ctrl} disabled={index >= playQueue.items.length - 1} onPress={() => go(1)}>
                <Ionicons name="play-skip-forward" size={26} color={index >= playQueue.items.length - 1 ? colors.muted : colors.onSurface} />
              </Pressable>
            </BlurView>
          </View>
        </>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: "#000000" },
  fill: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16 },
  overlay: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0, alignItems: "center", justifyContent: "center", gap: 12, padding: 32 },
  errorBg: { backgroundColor: c.scrim },
  loadingText: { color: c.onSurfaceSecondary, fontSize: 14 },
  errTitle: { color: c.onSurface, fontSize: 20, fontWeight: "700" },
  errText: { color: c.onSurfaceTertiary, fontSize: 14, textAlign: "center", maxWidth: 320 },
  errActions: { flexDirection: "row", gap: 12, marginTop: 8 },
  primaryBtn: { flexDirection: "row", alignItems: "center", gap: 8, height: 48, paddingHorizontal: 20, borderRadius: 12, backgroundColor: c.brandPrimary },
  primaryBtnText: { color: c.onBrandPrimary, fontSize: 15, fontWeight: "700" },
  secondaryBtn: { height: 48, paddingHorizontal: 20, borderRadius: 12, backgroundColor: c.surfaceTertiary, justifyContent: "center" },
  secondaryBtnText: { color: c.onSurface, fontSize: 15, fontWeight: "600" },
  top: { position: "absolute", top: 0, left: 0, right: 0, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingBottom: 12, backgroundColor: c.scrim },
  roundBtn: { width: 44, height: 44, borderRadius: 22, alignItems: "center", justifyContent: "center", backgroundColor: c.glass },
  topText: { flex: 1 },
  chName: { color: c.onSurface, fontSize: 16, fontWeight: "700" },
  chGroup: { color: c.muted, fontSize: 12, marginTop: 2 },
  bottomWrap: { position: "absolute", alignSelf: "center", borderRadius: 999, overflow: "hidden", borderWidth: 1, borderColor: c.borderStrong },
  bottom: { flexDirection: "row", alignItems: "center", gap: 24, paddingHorizontal: 24, paddingVertical: 8, backgroundColor: c.glass },
  ctrl: { width: 48, height: 48, alignItems: "center", justifyContent: "center" },
  playBtn: { width: 60, height: 60, borderRadius: 30, backgroundColor: c.brandPrimary, alignItems: "center", justifyContent: "center" },
}));
