# Specyfikacja UI — Income Tracker

## 1. Cel i charakter produktu

Income Tracker ma być desktopowym, nowoczesnym trackerem budżetów i transakcji. Interfejs powinien łączyć szybki przegląd finansów z wygodnym sprawdzaniem szczegółów: użytkownik od razu widzi najważniejsze liczby, a następnie może przejść do budżetu, konta, transakcji lub importu.

Punktem odniesienia jest przesłany dashboard finansowy: górna nawigacja w formie zaokrąglonych zakładek, kompozycja kart o różnych rozmiarach, duże wartości liczbowe, wykres w głównej części ekranu oraz wyrazisty pomarańczowy akcent. Należy zachować ten przyjazny, dashboardowy charakter, ale ograniczyć ozdobniki i nie pokazywać danych, których aplikacja nie potrafi wiarygodnie wyliczyć.

Dokument opisuje docelowy wygląd i zachowanie warstwy UI. Nie zmienia zasad domenowych, uprawnień, synchronizacji ani importu po stronie serwera.

## 2. Zasady projektowe

- Czytelność danych jest ważniejsza niż dekoracje i animacje.
- Jedna główna akcja na widok; pozostałe działania są drugorzędne lub dostępne w menu kontekstowym.
- Kolor zawsze ma znaczenie semantyczne i nie jest jedynym sposobem przekazywania informacji.
- Te same elementy, stany i hierarchia informacji obowiązują w motywie jasnym i ciemnym.
- Nie pokazujemy fikcyjnych sald, trendów ani wykresów. Jeśli brakuje danych, ekran ma wyjaśnić dlaczego i zaproponować następny krok.
- Interfejs jest po polsku; format daty, liczb i waluty powinien być lokalizowany. Kody walut pozostają zgodne z danymi.
- Import jest lokalny do momentu jawnego zatwierdzenia. UI jasno informuje, które dane i kiedy są wysyłane.

## 3. Struktura aplikacji

### 3.1. Powłoka

Docelowy główny ekran wykorzystuje układ inspirowany zrzutem:

1. **Górny pasek aplikacji**
   - Po lewej: znak/nazwa „Income Tracker”.
   - W centrum lub obok logo: nawigacja w postaci zaokrąglonych zakładek.
   - Po prawej: status synchronizacji, przełącznik motywu lub ustawienia, menu profilu.
   - Aktywna zakładka ma wyraźne, pełne wypełnienie; pozostałe są neutralne i nie konkurują z treścią.
2. **Nagłówek widoku**
   - Tytuł i krótki opis aktualnej sekcji.
   - Po prawej: okres, wybór budżetu lub główna akcja zależna od widoku.
3. **Obszar roboczy**
   - Siatka kart na ekranie przeglądu.
   - Pełna szerokość dla tabel, formularzy i importu.
   - Zawartość przewija się wewnątrz okna; nawigacja i nagłówki tabel pozostają dostępne.
4. **Komunikaty**
   - Sukces, informacja i błąd pokazujemy jako widoczny komunikat w kontekście widoku lub jako toast.
   - Operacje wymagające decyzji lub potwierdzenia nie mogą polegać wyłącznie na znikającym toście.

### 3.2. Nawigacja

Zakładki główne:

- **Przegląd** — podsumowanie wybranego budżetu i okresu.
- **Transakcje** — lista transakcji, filtry i szczegóły.
- **Budżety** — lista budżetów, członkostwa i zaproszenia.
- **Importy** — import wyciągu i historia dostępna w ramach danych aplikacji.
- **Konta** — konta przypisane do budżetu.
- **Ustawienia** — preferencje walutowe, wygląd i profil.

Nawigacja nie powinna sugerować, że funkcja jest gotowa, jeśli nie ma jej obsługi domenowej. Niedostępne sekcje należy ukryć albo oznaczyć jako niedostępne z krótkim wyjaśnieniem, a nie prezentować jako działające widoki.

### 3.3. Rozmiary i układ

- Projektuj przede wszystkim pod desktopowe okno Electron.
- Dla szerokiego okna przegląd używa siatki 12-kolumnowej. Karta salda może zajmować około połowy szerokości, a mniejsze karty podsumowania układają się obok niej.
- Karty mają wspólne wyrównanie, odstępy i promień zaokrąglenia. Różne rozmiary kart wynikają z hierarchii danych, nie z losowej dekoracji.
- Przy węższym oknie karty układają się w jedną kolumnę, tabele otrzymują własny poziomy scroll, a górna nawigacja może przewijać się poziomo lub przejść do menu.
- Nie zmniejszaj tekstu ani celów klikalnych poniżej czytelnego rozmiaru, by zmieścić wszystkie elementy w jednym wierszu.

## 4. Widoki

### 4.1. Logowanie i stan początkowy

- Przed sprawdzeniem sesji pokazuj niewielki stan ładowania, bez migotania całej aplikacji.
- Dla niezalogowanego użytkownika pokaż ekran powitalny z krótką informacją o aplikacji i przyciskiem „Zaloguj się przez Google”.
- Podczas logowania przycisk jest nieaktywny i opisany stanem postępu.
- Błędy logowania pokazuj zrozumiałym komunikatem i możliwością ponowienia.

### 4.2. Przegląd finansów

Nagłówek zawiera tytuł „Przegląd”, selektor budżetu i okresu oraz przycisk „Importuj plik”.

Karty:

- **Saldo** — tylko jeśli dostępne jest wiarygodne saldo dla wybranego zakresu; waluta pokazana jawnie.
- **Przychody** i **Wydatki** — wartości dla wybranego okresu, z krótkim opisem zakresu.
- **Pozostało w budżecie** — wyłącznie, gdy istnieje budżet lub limit pozwalający tę wartość obliczyć.
- **Wykres wydatków w czasie lub według kategorii** — prosta forma z legendą i etykietami; nie pokazuj pustego wykresu bez objaśnienia.
- **Cele oszczędnościowe / budżety kategorii** — postęp liczbowy i pasek, jeśli te dane są dostępne.

Każda karta ma krótki tytuł, wyróżnioną wartość i opcjonalnie drugorzędny kontekst (np. okres porównawczy). Zmianę względem okresu bazowego pokazuj z ikoną kierunku oraz opisem tekstowym. Kolor nie powinien samodzielnie przesądzać, czy zmiana jest dobra, czy zła.

Jeśli użytkownik nie ma jeszcze danych, pokaż pusty stan, np. „Zaimportuj pierwszy wyciąg, aby zobaczyć podsumowanie”, z przyciskiem prowadzącym do importu. Nie zastępuj pustych danych przykładowymi kwotami.

### 4.3. Transakcje

Widok zawiera:

- Tytuł „Transakcje”, wybór budżetu i zakres dat.
- Filtry: konto, typ transakcji, waluta i tekst wyszukiwania, o ile dane i backend je obsługują.
- Tabelę transakcji z kolumnami: data, opis, konto, kategoria (jeśli istnieje), typ, kwota i waluta.
- Przychód i wydatek rozróżniane tekstem/ikoną, a opcjonalnie także kolorem.
- Kliknięcie wiersza otwiera szczegóły w panelu bocznym albo rozwija wiersz; zamknięcie nie powinno kasować filtrów.
- Stan pustej listy rozróżnia „brak transakcji” od „filtry nic nie znalazły”.

Eksport, edycja kategorii, automatyczna synchronizacja i inne działania nie mogą być wyświetlane jako aktywne, dopóki nie są obsługiwane przez aplikację.

### 4.4. Budżety i współdzielenie

Lista budżetów jest przedstawiona jako tabela lub zwarte karty: nazwa, rola użytkownika i przycisk „Otwórz”. U góry znajduje się formularz „Utwórz budżet”.

Po otwarciu budżetu widok pokazuje:

- nazwę budżetu i rolę użytkownika;
- członków z czytelną etykietą roli;
- dla administratora: zaproszenia oraz formularz wygenerowania linku, opcjonalnie z adresem e-mail;
- działania administracyjne przy właściwym członku, nie jako zestaw przycisków powtarzanych w całej tabeli;
- „Opuść budżet” jako działanie drugorzędne.

Usunięcie członka, opuszczenie budżetu lub usunięcie profilu wymaga potwierdzenia. Treść potwierdzenia wyjaśnia konsekwencje, szczególnie gdy opuszcza ostatni członek lub administrator przekazuje rolę kolejnej osobie.

Zaproszenia pokazują status jako tekstową etykietę: oczekujące, zaakceptowane, odrzucone, anulowane lub wygasłe. Daty wygaśnięcia są widoczne bez konieczności otwierania dymka.

### 4.5. Import wyciągu CSV

Import jest pełnostronicowym widokiem lub wyraźnie wydzielonym panelem, a nie małym formularzem dopisanym pod listą budżetów. Proces składa się z kroków:

1. **Plik i prywatność**
   - Przycisk „Wybierz plik CSV” oraz strefa przeciągnij-i-upuść, jeśli dostępna w powłoce Electron.
   - Informacja, że parsowanie odbywa się lokalnie, a plik ani jego zawartość nie są wysyłane na tym etapie.
   - Po wybraniu pliku pokazuj nazwę, stan odczytu i możliwość wyboru innego pliku.
   - PDF nie jest obsługiwany przez aktualny podgląd: pokaż jednoznaczny komunikat, że podgląd PDF nie jest dostępny i plik nie został wysłany. Nie sugeruj, że PDF można zatwierdzić.
2. **Kontekst importu**
   - Wybór budżetu, następnie własnego konta w tym budżecie.
   - Jeśli nie ma konta, pokaż akcję „Utwórz konto” z nazwą, walutą i rodzajem konta.
   - Po zmianie budżetu wyczyść wybór konta, aby uniknąć importu do niewłaściwego budżetu.
3. **Ustawienia parsowania**
   - Profil parsera: automatyczne rozpoznanie, historia transakcji albo konto oszczędnościowe.
   - Separator i kodowanie z możliwością pozostawienia automatycznego wykrywania.
   - Mapowanie kolumn tylko wtedy, gdy rozpoznano profil. Dla każdej mapowanej wartości pokaż nazwę pola i dostępne nagłówki pliku.
   - Zmiana ustawień odświeża lokalny podgląd bez wysyłania pliku.
4. **Podgląd i korekta**
   - Zamiast listy długich formularzy użyj tabeli z nagłówkiem pozostającym widocznym przy przewijaniu.
   - Kolumny: decyzja, numer wiersza, data, opis, kwota, waluta, typ i stan/uwagi. Dodatkowe pola, takie jak opłata lub saldo, pokaż w szczegółach wiersza.
   - Edycja danych odbywa się bezpośrednio w wierszu albo w rozwijanym panelu szczegółów.
   - Nad tabelą pokaż podsumowanie liczby wierszy: gotowe, wymagające sprawdzenia, błędne, oczekujące na decyzję i wykluczone.
   - Każda uwaga jest przypisana do konkretnego wiersza i zawiera instrukcję, co poprawić.
   - Użytkownik może jawnie uwzględnić lub wykluczyć wiersz. Błędnego wiersza nie można uwzględnić, dopóki wymagane pola nie są poprawne.
   - Możliwy duplikat jest stanem wymagającym jawnej decyzji: „To nie duplikat — importuj” albo „Pomiń jako duplikat”. Nie zaznaczaj żadnej z tych opcji automatycznie.
5. **Zatwierdzenie**
   - Główny przycisk „Zatwierdź import” znajduje się podsumowaniu procesu i jest nieaktywny, dopóki nie wybrano budżetu i konta, istnieje poprawny profil parsera, wybrano co najmniej jeden wiersz do importu i wszystkie decyzje są rozstrzygnięte.
   - Przy zatwierdzaniu pokaż stan „Importowanie…” i zapobiegaj wielokrotnemu wysłaniu żądania.
   - Po sukcesie pokaż liczbę zaimportowanych transakcji i pominiętych duplikatów. Jeśli plik był już importowany dla tego konta, pokaż osobny komunikat o braku ponownego importu.
   - Przy błędzie zachowaj wybory użytkownika i wskaż wiersz lub akcję wymagającą poprawy.

Wiersze importu nie mogą być oznaczane wyłącznie kolorem. Używaj tekstowej etykiety, ikony i — gdy trzeba — szczegółowego opisu błędu.

### 4.6. Ustawienia i profil

- Preferencje walutowe: waluta podstawowa oraz lista dodatkowych walut.
- Wygląd: tryb jasny, ciemny lub systemowy.
- Menu profilu: aktualnie zalogowany użytkownik i wylogowanie.
- Usuwanie profilu znajduje się w osobnej, wyraźnie oznaczonej sekcji ryzykownej; przed wykonaniem pokaż konsekwencje oraz przyciski „Usuń profil” i „Zachowaj profil”.
- Preferencja motywu jest lokalnie zapamiętywana i przywracana po ponownym uruchomieniu.

## 5. System wizualny

### 5.1. Typografia, siatka i karty

- Użyj czytelnego fontu systemowego lub istniejącego fontu projektu; bez dekoracyjnych krojów.
- Tytuły widoków są wyraźne, ale nie konkurują z głównymi wartościami kart.
- Główna kwota jest największym elementem karty; etykieta i okres mają mniejszy, ale czytelny rozmiar.
- Stosuj konsekwentny rytm odstępów oparty na wielokrotnościach 4 px (np. 8, 12, 16, 24, 32).
- Karty: promień około 14–18 px, cienka ramka lub bardzo subtelny cień, bez ciężkich gradientów.
- Pomarańcz używany oszczędnie: aktywna nawigacja, główne przyciski, istotne wyróżnienie wykresu i postępów. Nie koloruj wszystkich ikon i obramowań jednocześnie.

### 5.2. Tokeny kolorów

Wszystkie komponenty korzystają z tokenów tematu, nie z lokalnie wpisanych kolorów. Poniższe wartości są bazą i mogą zostać skorygowane po weryfikacji kontrastu.

| Token | Jasny | Ciemny | Zastosowanie |
|---|---|---|---|
| `app-bg` | `#F3F4F6` | `#15171A` | tło aplikacji |
| `surface` | `#FFFFFF` | `#202328` | karty, menu, formularze |
| `surface-muted` | `#F0F1F3` | `#292D33` | pola, elementy drugorzędne |
| `text-primary` | `#202124` | `#F3F4F6` | nagłówki i główne wartości |
| `text-secondary` | `#6B7078` | `#A7ADB6` | opisy i metadane |
| `border` | `#E2E4E8` | `#383D45` | obramowania i separatory |
| `accent` | `#F47721` | `#FF8A3D` | główne działania i aktywna nawigacja |
| `accent-contrast` | `#FFFFFF` | `#21150D` | tekst na akcencie |
| `success` | `#18845B` | `#50C995` | sukces i przychód |
| `warning` | `#A45D00` | `#F2B84B` | ostrzeżenia i wymagana decyzja |
| `danger` | `#B42318` | `#FF766C` | błąd i destrukcyjne działanie |
| `info` | `#2563A6` | `#78B7F2` | informacja |

Wykresy korzystają z ograniczonej palety. Kategorie mogą mieć własne kolory, ale muszą zachować czytelność na obu tłach. Nie używaj czerwieni i zieleni jako jedynego rozróżnienia przychodów i wydatków.

### 5.3. Tryby jasny i ciemny

**Jasny**

- Tło aplikacji jest jasnoszare, a karty i panele są białe.
- Tekst główny jest grafitowy; pomocniczy ma niższy kontrast, ale pozostaje czytelny.
- Pomarańczowy akcent przypomina przykład referencyjny, ale nie dominuje nad danymi.
- Cienie są bardzo delikatne; granice kart można dodatkowo odróżniać cienką ramką.

**Ciemny**

- Tło jest grafitowe, nie czarne; karty mają nieco jaśniejszą powierzchnię.
- Tekst główny jest jasny, tekst pomocniczy ma wystarczający kontrast.
- Pomarańcz jest jaśniejszy niż w motywie jasnym, aby zachować czytelność przycisków i aktywnej nawigacji.
- Separacja kart opiera się przede wszystkim na różnicy powierzchni i subtelnej ramce, nie na mocnym cieniu.
- Nie odwracaj po prostu wszystkich kolorów. Wykresy, błędy, statusy i focus muszą być dostosowane do ciemnych powierzchni.

Przełącznik ma trzy opcje: **Jasny**, **Ciemny**, **Systemowy**. Zmiana jest natychmiastowa i nie przeładowuje widoku. W trybie systemowym aplikacja reaguje na ustawienie systemu.

## 6. Komponenty i interakcje

### 6.1. Przyciski

- **Główny:** wypełniony akcentem, np. „Importuj plik”, „Zatwierdź import”.
- **Drugorzędny:** neutralna powierzchnia i obramowanie, np. „Anuluj”, „Otwórz”.
- **Destrukcyjny:** styl niebezpiecznej akcji i dodatkowe potwierdzenie.
- Stan nieaktywny jest widoczny, ale tekst nadal pozostaje czytelny. Jeśli przyczyna nie jest oczywista, pokaż krótkie wyjaśnienie obok przycisku.
- Każdy przycisk ma stany hover, focus, pressed i disabled. Sam hover nie może być jedyną wskazówką dostępności.

### 6.2. Karty i wskaźniki

- Cała karta nie jest klikalna, chyba że jest to wyraźnie zaznaczone.
- Wskaźnik zmiany zawiera ikonę kierunku, wartość i tekst okresu porównania.
- Pasek postępu ma obok dokładną wartość, np. `72%` oraz `7 200 / 10 000 CHF`.
- Karty nie pokazują wykresów bez legendy, jednostki i zakresu czasu.

### 6.3. Tabele

- Nagłówek kolumn ma czytelną nazwę, aktywny stan sortowania i widoczny fokus.
- Kwoty są wyrównane do prawej i zawsze mają walutę lub kontekst waluty.
- Daty, opisy i kwoty pozostają czytelne także przy długiej treści; obcinany tekst ma dostępny pełny szczegół po otwarciu wiersza, nie tylko przez tooltip.
- Hover wiersza jest subtelny; zaznaczenie i fokus klawiatury są wyraźniejsze.
- Linie podziału są lekkie. Nie stosuj mocnego naprzemiennego cieniowania każdego wiersza.
- Na wąskim oknie tabela przewija się poziomo we własnym obszarze, bez rozbijania kolumn na nieczytelne karty.
- Pusta tabela rozróżnia brak danych od braku wyników po filtrze.

### 6.4. Tooltipy, dymki i menu

- Tooltip służy wyłącznie do krótkiego opisu ikony, skrótu lub nieoczywistej etykiety.
- Pojawia się po krótkim opóźnieniu, działa na hover i focus klawiatury, nie zasłania istotnych kontrolek i znika po opuszczeniu elementu lub Escape.
- Błędy, ostrzeżenia importu, konsekwencje usunięcia i ważne statusy są widoczne w treści widoku, nie tylko w tooltipie.
- Menu kontekstowe otwiera się przy kontrolce, można je obsługiwać klawiaturą i zamknąć przez Escape lub klik poza menu.

### 6.5. Formularze

- Każde pole ma widoczną etykietę; placeholder nie zastępuje etykiety.
- Błąd walidacji jest pokazany przy polu i opisuje, jak je poprawić.
- Akcje asynchroniczne blokują tylko kontrolki, których dotyczą.
- Po sukcesie zachowuj kontekst i pokaż jasne potwierdzenie; po błędzie zachowuj wpisane dane, o ile ponowienie jest bezpieczne.

## 7. Stany, wyszarzenie i komunikaty

- **Ładowanie:** szkielet kart lub wierszy o docelowym rozmiarze; unikaj migotania i pustej bieli.
- **Pusto:** wyjaśnienie, dlaczego nie ma danych, oraz jedna konkretna akcja do wykonania.
- **Nieaktywne:** używaj przycisku disabled tylko wtedy, gdy akcja rzeczywiście nie może zostać wykonana. Utrzymaj czytelny kontrast i wyjaśnij przyczynę.
- **Dane drugorzędne/archiwalne:** można je przygasić, ale nie stosuj tak niskiego kontrastu, by wyglądały na wyłączone lub niedostępne.
- **Sukces:** tekstowe potwierdzenie z ikoną; nie polegaj wyłącznie na zieleni.
- **Ostrzeżenie:** informuje o decyzji lub ryzyku, ale nie blokuje bez powodu.
- **Błąd:** opisuje problem prostym językiem i sugeruje następną akcję. Nie wyświetlaj użytkownikowi surowych stack trace ani technicznych payloadów.
- **Offline / synchronizacja:** widoczny status „Offline”, „Synchronizowanie…” lub „Zapisano”. Nie pokazuj „Zapisano”, jeśli operacja jest jedynie oczekująca na synchronizację.
- Toast nie znika, zanim użytkownik zdąży go przeczytać; błąd wymagający działania pozostaje widoczny w widoku.

## 8. Dostępność i obsługa klawiaturą

- Wszystkie działania są dostępne klawiaturą; kolejność Tab odpowiada kolejności wizualnej.
- Fokus jest zawsze widoczny w obu motywach.
- Ikony będące przyciskami mają nazwę dostępną dla czytnika ekranu.
- Statusy operacji i błędy są ogłaszane przez właściwe regiony statusu/alertu.
- Kontrast tekstu i kontrolek jest sprawdzany w obu motywach. Kolor nigdy nie jest jedynym nośnikiem statusu.
- Klikalne cele są dostatecznie duże i oddzielone; nie opieraj ważnych akcji na precyzyjnym trafianiu w małą ikonę.
- Animacje są krótkie i nie blokują interakcji; należy respektować preferencję ograniczenia ruchu systemu.

## 9. Zakres istniejących funkcji a docelowy kierunek

Obecna aplikacja ma już elementy sesji użytkownika, budżetów i członkostw, zaproszeń, preferencji walutowych oraz lokalnego podglądu i zatwierdzania importu CSV. Nowa warstwa wizualna powinna opakować te działania w spójny shell i zachować ich dotychczasowe reguły.

Zrzut referencyjny pokazuje także wykresy, cele oszczędnościowe i podsumowania finansowe. Można je dodać do docelowego dashboardu dopiero wtedy, gdy istnieją odpowiednie dane i logika. Nie należy tworzyć statycznych wartości demonstracyjnych w widoku produkcyjnym. PDF nie jest obecnie obsługiwany przez podgląd importu i UI ma to jasno komunikować.

Istniejące diagnostyczne kontrolki prototypu (np. symulacja sieci lub testowy zapis pliku) nie należą do głównej nawigacji użytkownika końcowego. Jeśli są nadal potrzebne deweloperom, powinny być widoczne wyłącznie w trybie deweloperskim.

## 10. Kryteria akceptacji UI

- Użytkownik potrafi rozpoznać aktywną sekcję, wybrany budżet i okres bez otwierania dodatkowego menu.
- Główna kwota oraz waluta są czytelne w obu motywach.
- Jasny i ciemny motyw mają zgodną hierarchię, stany i znaczenia semantycznych kolorów.
- Motyw Systemowy respektuje preferencję systemu, a wybór zapisany przez użytkownika wraca po ponownym uruchomieniu.
- Użytkownik rozumie każdy status importowanego wiersza i może poprawić lub jawnie wykluczyć wiersz.
- Import nie jest zatwierdzalny przy nierozstrzygniętych błędach, decyzjach o duplikatach lub braku wymaganych danych.
- Interfejs jasno informuje, że CSV jest parsowany lokalnie oraz że PDF nie ma jeszcze podglądu.
- Nieaktywne elementy pozostają czytelne, a przyczyna ich niedostępności jest zrozumiała.
- Najważniejsze ścieżki da się obsłużyć klawiaturą i nie wymagają hovera.
- Puste, ładowane, offline, sukcesu i błędne stany są zaprojektowane; brak danych nie powoduje wyświetlenia fikcyjnych wartości.
