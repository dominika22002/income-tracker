podsumowanie etapu 1:

Zrobione — zrealizowałem Etap 0 (bez wchodzenia w Etap 1+), z implementacją i uruchomioną weryfikacją.

Co wdrożyłem
1) Szkielet desktopowy Electron + React + TypeScript
Konfiguracja projektu i build chain:
package.json
electron.vite.config.ts
tsconfig.base.json
tsconfig.node.json
tsconfig.web.json
tsconfig.test.json
Minimalna aplikacja desktopowa z podstawowym ekranem:
src/main/index.ts
src/preload/index.ts
src/renderer/src/App.tsx
src/renderer/src/main.tsx
src/renderer/index.html
2) Bezpieczny podział main/preload/renderer + ograniczony IPC
Włączone:
contextIsolation: true
nodeIntegration: false
sandbox: true
Ograniczony i typowany interfejs preload/IPC:
src/shared/contracts.ts
src/main/ipc.ts
src/shared/validators.ts
3) Wybór pliku + bezpieczny zapis do katalogu aplikacji
Native dialog wyboru pliku (obsługa anulowania + błędów widocznych w UI).
Zapis testowego pliku do app.getPath('userData')/stage0-prototype/... (obsługa błędów).
4) Prototyp OAuth Google przez zewnętrzną przeglądarkę
Start OAuth przez shell.openExternal(...), bez webview.
Callback + walidacja state:
src/main/oauth.ts
src/main/ipc.ts
Jest to prototyp Stage 0: realny live-flow wymaga ręcznej konfiguracji OAuth/Firebase (opisane w README).
5) Firebase (Auth/Firestore) + reguły po stronie backendu + emulator
Konfiguracja dev/emulator:
firebase.json
firestore.rules
src/renderer/src/firebase/config.ts
.env.example
Test integracyjny emulatora reguł dostępu:
tests/rules/firestore.rules.test.ts
6) Testy jednostkowe (izolowalne logiki) i online/offline
Walidacje wiadomości/stanu:
tests/unit/validators.test.ts
OAuth/session-state:
tests/unit/oauth.test.ts
Online/offline + pending/confirmed:
src/shared/syncState.ts
tests/unit/syncState.test.ts
Minimalny UI test:
tests/unit/app.test.tsx
7) Lint/format/typecheck/test/build + CI macOS/Windows
Konfiguracja jakości:
.eslintrc.cjs
prettier.config.cjs
vitest.config.ts
.prettierignore
CI:
.github/workflows/ci.yml
8) Dokumentacja
Pełny opis uruchamiania, emulatorów, testów, buildów i ograniczeń:
README.md
Doprecyzowanie mapowania testów Etapu 0:
scenariusze-testow.md
Rozbieżność DBML vs Etap 0 i decyzja
DBML jest pełnym modelem (Etap 1+), a Etap 0 wymaga głównie prototypu i testu reguł dostępu.
Przyjąłem minimalną, bezpieczną decyzję: w testach reguł użyty jest tylko podzbiór modelu (users, budgets, memberships, budget_records) do walidacji TR-06, bez tworzenia alternatywnego „pełnego” schematu.

Co uruchomiłem i wyniki
Uruchomione lokalnie (faktycznie wykonane):

npm run format ✅
npm run lint ✅
npm run typecheck ✅
npm run test:unit ✅ (14 testów)
npm run test:rules ✅ (Firestore Emulator, 3 testy reguł)
npm run build:mac ✅ (artefakty wygenerowane)
npm run build:win ✅ (artefakty Windows wygenerowane na macOS)
npm run dev ✅ (dev server + start Electron; pojawił się pojedynczy log EGL, proces wystartował)
Co wymaga ręcznej konfiguracji
Realna konfiguracja Google OAuth i Firebase projektu (bez sekretów w repo).
Weryfikacja rzeczywistego login/logout OAuth z prawdziwym kontem.
Podpisywanie/notaryzacja/SmartScreen (świadomie poza Etapem 0).
Ryzyka / ograniczenia
OAuth live-flow nie był „na żywo” testowany (brak danych konfiguracyjnych/poświadczeń w repo) — jest prototyp z poprawnym kierunkiem architektury i walidacją state.
Brak konfiguracji certyfikatów podpisu (build przechodzi, podpisywanie pominięte).
Jeśli chcesz, w kolejnym kroku mogę przygotować krótką checklistę manualnych testów M-* do wykonania na docelowych systemach (bez implementacji Etapu 1).

