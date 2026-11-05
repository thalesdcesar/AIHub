# IPTV Player (Expo) – PRD
## Original request
"Crie um aplicativo mobile: E CORRIGE OS ERRO DE REPRODUÇÃO DE CANAIS E NA TELA INICIAL TIRAR TODAS AS FERRAMENTAS QUE APARECE E DEIXAR SOMENTE O MAC E A SENHA E O STATUS DA LISTA" (source: Vite web IPTV project zip). Choices: bug = trava/carregando infinito; home = only MAC, Senha, Status; modernize visual.
## Architecture
- Backend FastAPI: Firestore REST (project painel-iptv-45218, collection clientes) for device status; playlist download+parse+cache in memory (handles 76MB/300k items); paginated channel API.
- Frontend Expo Router: / (activation: MAC, Senha, Status only, polls 4s), /browser (4 sections, groups, search, infinite list), /player (expo-video, HLS-first candidates for Xtream live, 15s start timeout, stall watchdog, retry).
## Implemented (2026-06)
- All above; playback fix tested (5 test iterations).
## Backlog
- P1: Real-device QA on Android TV (D-pad focus navigation), favorites, continue watching
- P2: EPG guide, parental PIN
