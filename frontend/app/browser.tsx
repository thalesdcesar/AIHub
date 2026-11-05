import { Ionicons } from "@react-native-vector-icons/ionicons";
import { BlurView } from "expo-blur";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api, ApiError, Channel, Section, Summary } from "@/src/api";
import { getIdentity, Identity } from "@/src/device";
import { playQueue } from "@/src/queue";
import { makeStyles, useTheme } from "@/src/theme";

const SECTIONS: { key: Section; label: string; icon: "tv" | "film" | "albums" | "musical-notes" }[] = [
  { key: "tv", label: "TV Ao Vivo", icon: "tv" },
  { key: "movies", label: "Filmes", icon: "film" },
  { key: "series", label: "Séries", icon: "albums" },
  { key: "music", label: "Músicas", icon: "musical-notes" },
];

export default function Browser() {
  const styles = useStyles();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [id, setId] = useState<Identity | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [section, setSection] = useState<Section>("tv");
  const [group, setGroup] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [items, setItems] = useState<Channel[]>([]);
  const [total, setTotal] = useState(0);
  const [loadingList, setLoadingList] = useState(false);
  const [listError, setListError] = useState(false);
  const reqId = useRef(0);

  useEffect(() => { getIdentity().then(setId); }, []);

  const loadSummary = useCallback(async (refresh = false) => {
    if (!id) return;
    setSummary(null);
    let first = true;
    while (true) {
      try {
        const s = await api.summary(id.mac, id.pin, refresh && first);
        first = false;
        if (s.state !== "loading") { setSummary(s); return; }
        setSummary(s);
      } catch (e) {
        if (e instanceof ApiError && e.status === 403) { router.replace("/"); return; }
        setSummary({ state: "error", error: "Sem conexão com o servidor." });
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }, [id, router]);

  useEffect(() => { loadSummary(); }, [loadSummary]);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 350);
    return () => clearTimeout(t);
  }, [query]);

  const fetchPage = useCallback(async (offset: number) => {
    if (!id || summary?.state !== "ready") return;
    const my = ++reqId.current;
    setLoadingList(true);
    setListError(false);
    try {
      const r = await api.channels({ mac: id.mac, pin: id.pin, section, group, q: debounced, offset });
      if (my !== reqId.current) return;
      setItems((prev) => (offset === 0 ? r.items : [...prev, ...r.items]));
      setTotal(r.total);
    } catch {
      if (my === reqId.current) setListError(true);
    } finally {
      if (my === reqId.current) setLoadingList(false);
    }
  }, [id, summary?.state, section, group, debounced]);

  useEffect(() => { setItems([]); fetchPage(0); }, [fetchPage]);

  const openChannel = useCallback((index: number) => {
    playQueue.items = items;
    playQueue.index = index;
    router.push("/player");
  }, [items, router]);

  const groups = summary?.groups?.[section] ?? [];
  const ready = summary?.state === "ready";

  const renderItem = useCallback(({ item, index }: { item: Channel; index: number }) => (
    <ChannelRow item={item} onPress={() => openChannel(index)} />
  ), [openChannel]);

  return (
    <View style={styles.root} testID="browser-screen">
      <BlurView intensity={30} tint="dark" style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <View style={styles.titleRow}>
          <Text style={styles.title}>IPTV</Text>
          <View style={styles.badge} testID="browser-status-badge">
            <View style={styles.badgeDot} />
            <Text style={styles.badgeText}>Lista ativa</Text>
          </View>
          <Pressable testID="reload-playlist-button" hitSlop={8} onPress={() => loadSummary(true)} style={styles.iconBtn}>
            <Ionicons name="refresh" size={20} color={colors.onSurface} />
          </Pressable>
        </View>
        <View style={styles.search}>
          <Ionicons name="search" size={18} color={colors.muted} />
          <TextInput
            testID="search-input"
            value={query}
            onChangeText={setQuery}
            placeholder="Buscar canal, filme ou série"
            placeholderTextColor={colors.muted}
            style={styles.searchInput}
            returnKeyType="search"
            autoCorrect={false}
          />
          {query ? (
            <Pressable testID="clear-search-button" hitSlop={8} onPress={() => setQuery("")}>
              <Ionicons name="close-circle" size={18} color={colors.muted} />
            </Pressable>
          ) : null}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow} contentContainerStyle={styles.chipContent}>
          {SECTIONS.map((s) => {
            const active = s.key === section;
            return (
              <Pressable
                key={s.key}
                testID={`section-chip-${s.key}`}
                onPress={() => { setSection(s.key); setGroup(undefined); }}
                style={[styles.chip, active && styles.chipActive]}
              >
                <Ionicons name={s.icon} size={14} color={active ? colors.onBrandPrimary : colors.onSurfaceTertiary} />
                <Text style={[styles.chipText, active && styles.chipTextActive]}>
                  {s.label}{summary?.counts ? ` · ${summary.counts[s.key]}` : ""}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
        {ready && groups.length > 0 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.chipRow} contentContainerStyle={styles.chipContent}>
            <Pressable testID="group-chip-all" onPress={() => setGroup(undefined)} style={[styles.chip, !group && styles.groupActive]}>
              <Text style={[styles.chipText, !group && styles.chipTextActive]}>Todos</Text>
            </Pressable>
            {groups.map((g, i) => (
              <Pressable key={g.name} testID={`group-chip-${i}`} onPress={() => setGroup(g.name)} style={[styles.chip, group === g.name && styles.groupActive]}>
                <Text style={[styles.chipText, group === g.name && styles.chipTextActive]} numberOfLines={1}>{g.name}</Text>
              </Pressable>
            ))}
          </ScrollView>
        ) : null}
      </BlurView>

      {!ready ? (
        <View style={styles.state} testID="playlist-state">
          {summary?.state === "error" ? (
            <>
              <Ionicons name="cloud-offline" size={40} color={colors.error} />
              <Text style={styles.stateTitle}>Falha ao carregar a lista</Text>
              <Text style={styles.stateText}>{summary.error}</Text>
              <Pressable testID="retry-playlist-button" style={styles.primaryBtn} onPress={() => loadSummary(true)}>
                <Text style={styles.primaryBtnText}>Tentar novamente</Text>
              </Pressable>
            </>
          ) : (
            <>
              <ActivityIndicator size="large" color={colors.brandPrimary} />
              <Text style={styles.stateTitle}>Carregando sua lista...</Text>
              <Text style={styles.stateText}>
                {summary?.progress ? `${summary.progress.toLocaleString("pt-BR")} itens processados` : "Listas grandes podem levar alguns segundos"}
              </Text>
            </>
          )}
        </View>
      ) : (
        <FlatList
          testID="channel-list"
          data={items}
          keyExtractor={(c) => String(c.id)}
          renderItem={renderItem}
          contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 24 }]}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          onEndReachedThreshold={0.6}
          onEndReached={() => { if (!loadingList && items.length < total) fetchPage(items.length); }}
          initialNumToRender={14}
          windowSize={9}
          removeClippedSubviews
          ListHeaderComponent={<Text style={styles.count} testID="channel-count">{total.toLocaleString("pt-BR")} itens</Text>}
          ListFooterComponent={loadingList ? <ActivityIndicator style={styles.footer} color={colors.brandPrimary} /> : null}
          ListEmptyComponent={!loadingList ? (listError ? (
            <View style={styles.state} testID="list-error-state">
              <Ionicons name="cloud-offline" size={36} color={colors.error} />
              <Text style={styles.stateTitle}>Erro ao carregar</Text>
              <Pressable testID="retry-list-button" style={styles.primaryBtn} onPress={() => fetchPage(0)}>
                <Text style={styles.primaryBtnText}>Tentar novamente</Text>
              </Pressable>
            </View>
          ) : (
            <View style={styles.state} testID="empty-state">
              <Ionicons name="search" size={36} color={colors.muted} />
              <Text style={styles.stateTitle}>Nada encontrado</Text>
              <Text style={styles.stateText}>Tente outra categoria ou busca</Text>
            </View>
          )) : null}
        />
      )}
    </View>
  );
}

const ChannelRow = memo(function ChannelRow({ item, onPress }: { item: Channel; onPress: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const [failed, setFailed] = useState(false);
  return (
    <Pressable testID={`channel-item-${item.id}`} onPress={onPress} style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}>
      <View style={styles.logoBox}>
        {item.logo && !failed ? (
          <Image source={{ uri: item.logo }} style={styles.logo} contentFit="contain" onError={() => setFailed(true)} recyclingKey={String(item.id)} />
        ) : (
          <Ionicons name={item.section === "tv" ? "tv-outline" : item.section === "music" ? "musical-notes-outline" : "film-outline"} size={22} color={colors.muted} />
        )}
      </View>
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>{item.name}</Text>
        <Text style={styles.rowSub} numberOfLines={1}>{item.group}</Text>
      </View>
      <Ionicons name="play-circle" size={28} color={colors.brandPrimary} />
    </Pressable>
  );
});

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.surface },
  header: { backgroundColor: c.scrim, borderBottomWidth: 1, borderBottomColor: c.border, paddingBottom: 8 },
  titleRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, gap: 12, height: 44 },
  title: { color: c.onSurface, fontSize: 24, fontWeight: "800", letterSpacing: 1 },
  badge: { flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: c.surfaceSecondary, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4, borderWidth: 1, borderColor: c.border },
  badgeDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: c.success },
  badgeText: { color: c.onSurfaceSecondary, fontSize: 12, fontWeight: "600" },
  iconBtn: { marginLeft: "auto", width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  search: { flexDirection: "row", alignItems: "center", gap: 8, marginHorizontal: 16, marginTop: 8, paddingHorizontal: 12, height: 44, borderRadius: 12, backgroundColor: c.surfaceTertiary },
  searchInput: { flex: 1, color: c.onSurface, fontSize: 14, paddingVertical: 0 },
  chipRow: { height: 56, flexGrow: 0 },
  chipContent: { gap: 8, paddingHorizontal: 16, alignItems: "center" },
  chip: { flexShrink: 0, height: 36, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, borderRadius: 999, backgroundColor: c.surfaceSecondary, borderWidth: 1, borderColor: c.border, maxWidth: 240 },
  chipActive: { backgroundColor: c.brandPrimary, borderColor: c.brandPrimary },
  groupActive: { backgroundColor: c.brandTertiary, borderColor: c.brandSecondary },
  chipText: { color: c.onSurfaceTertiary, fontSize: 13, fontWeight: "600" },
  chipTextActive: { color: c.onBrandPrimary },
  list: { paddingHorizontal: 16, paddingTop: 12 },
  count: { color: c.muted, fontSize: 12, marginBottom: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 12, marginBottom: 8, borderRadius: 12, backgroundColor: c.surfaceSecondary, borderWidth: 1, borderColor: c.border },
  rowPressed: { backgroundColor: c.surfaceTertiary },
  logoBox: { width: 56, height: 56, borderRadius: 6, backgroundColor: c.surface, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  logo: { width: 56, height: 56 },
  rowText: { flex: 1 },
  rowTitle: { color: c.onSurface, fontSize: 15, fontWeight: "700" },
  rowSub: { color: c.muted, fontSize: 12, marginTop: 4 },
  footer: { marginVertical: 16 },
  state: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 12, minHeight: 300 },
  stateTitle: { color: c.onSurface, fontSize: 18, fontWeight: "700", textAlign: "center" },
  stateText: { color: c.muted, fontSize: 14, textAlign: "center" },
  primaryBtn: { marginTop: 8, height: 48, paddingHorizontal: 24, borderRadius: 12, backgroundColor: c.brandPrimary, justifyContent: "center" },
  primaryBtnText: { color: c.onBrandPrimary, fontSize: 15, fontWeight: "700" },
}));
