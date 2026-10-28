podsumowanie etapu 0:

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

podsumowanie etapu 1:
Etap 1 jest zaimplementowany i wszystkie testy przechodzą. Nie robiłem commitów — zmiany są w working tree, kroki 1–8 zrobiłem po kolei, po każdym uruchamiając testy.

Co zrobiono
Plan: docs/etap-1-mapowanie.md opisuje mapowanie DBML → Firestore, indeksy, reguły, transakcje i wykryte rozbieżności R1–R9. Wdrożyłem go po Twojej decyzji D1–D3; D4, D5 i R8 przyjąłem wg rekomendacji z planu.
Zainstalowałem JDK 21 przez winget, bo na maszynie nie było Javy.
Reguły (firestore.rules): klient ma tylko odczyt danych tożsamości, budżetów, członkostw i zaproszeń. Dostęp do danych budżetu daje istnienie dokumentu budgets/{id}/active_members/{uid}. Serwer tworzy go i usuwa w tej samej transakcji co członkostwo.
Logika serwerowa: src/server/ plus callable Cloud Functions w functions/. Czysta logika domeny jest w src/shared/domain/.
profil i preferencje (domyślnie CHF, PLN, EUR);
atomowe utworzenie budżetu z pierwszym adminem;
zaproszenia: w bazie tylko skrót SHA-256 tokenu, ważność 7 dni, anulowanie, akceptacja, odrzucenie, zużycie linku i członkostwo w jednej transakcji;
odejście, usunięcie członka i następca admina wg joined_at, potem membership_id;
usunięcie budżetu, gdy odchodzi ostatni członek;
trwałe usunięcie profilu: zakończenie członkostw, anonimizacja user_id, historia i dane budżetu bez zmian.
UI w src/renderer/src/features/budgets/: tworzenie budżetu, zaproszenie, akceptacja i odrzucenie, odejście, usunięcie członka, waluty, usunięcie profilu. Bez nowych kanałów IPC.
Pozostałe: ESLint zabrania firebase-admin w kodzie klienta, CI ma nowe kroki, README i scenariusze-testow.md są zaktualizowane.
Wyniki weryfikacji
Komenda	Wynik
npm run format / lint / typecheck	OK
npm run test:unit	72 testy
npm run test:rules	81 testów (reguły i serwisy na emulatorze)
npm run test:e2e	8 testów (UI; stabilny w 3 kolejnych uruchomieniach)
npm run test:functions	3 testy (callable na emulatorach Auth, Firestore i Functions)
test:e2e i test:functions to nowe skrypty dodane obok test:rules. Build electron-vite build też przechodzi.

Decyzje projektowe
Zaproszenia: jednorazowość jest ścisła, bo DBML nie ma pól accepted_by/resolved_at. Próba akceptacji przez osobę będącą już członkiem nie zużywa linku. invitee_email jest opcjonalne i wymaga zweryfikowanego e-maila.
Usunięcie budżetu: dwie fazy. Transakcja blokuje dostęp, a ponawialne czyszczenie (znacznik budget_purge_queue) usuwa resztę danych.
UI po utracie dostępu: przy błędzie permission-denied odświeża listę budżetów, bo emulator nie dostarczał wtedy pozostałych aktualizacji.
E2E (zmiana względem planu): wszystko poza transportem callable działa w procesie; transport sprawdza osobny test dymny.
Poza planem: dodałem podsumowanie.md do .prettierignore, bo ten plik już w HEAD nie przechodził prettier --check. Nie zmieniałem jego treści.
Otwarte
Cloud Functions wymagają planu Blaze przy wdrożeniu, a region nie jest wybrany (domyślnie us-central1).
App Check nie jest skonfigurowany.
Prawdziwe logowanie Google (wymiana tokenu w sesję Firebase) nadal jest prototypem z Etapu 0. Do tego dochodzą rejestracja linku income-tracker://invite w systemie i testy ręczne na macOS/Windows.
Dane display_name i email kopiowane do active_members nie odświeżają się po zmianie w Google.
Zachowanie nasłuchów Firestore sprawdziłem tylko na emulatorze.