# Etap 8 — kopie zapasowe i odtwarzanie

## Format lokalnej kopii

Kopia jest plikiem JSON `income-tracker-backup` w wersji schematu 2. Zawiera
datę utworzenia, źródłowy budżet, zbiory danych budżetu, historię członkostw
potrzebną do mapowania autorów, opcjonalne ustawienia walut oraz dostępne na
urządzeniu oryginalne pliki CSV/PDF. SHA-256 liczony jest z kanonicznej
reprezentacji danych; pliki wyciągów mają dodatkowo własne skróty. Odczyt
sprawdza integralność, strukturę, zależności rekordów i pola wyglądające na
hasła, tokeny lub sekrety. Jedyną zaimplementowaną migracją jest wersja 1 do 2.

Kopie są nieszyfrowane i zawierają wrażliwe dane finansowe. Interfejs wymaga
potwierdzenia ostrzeżenia przed otwarciem okna zapisu; anulowanie okna nie
zapisuje pliku. Dane logowania i sekrety uwierzytelniające nie są eksportowane.

## Odtwarzanie i członkostwa

Odtwarzanie wymaga istniejącego budżetu dostępnego dla bieżącego użytkownika.
Backend ponownie sprawdza aktywne członkostwo, waliduje wszystkie dokumenty
w rewizji stagingowej i przełącza `active_revision_id` dopiero po poprawnym
zakończeniu walidacji. To przełączenie jest atomowym punktem aktywacji; błąd
walidacji, wysyłania lub zatwierdzenia nie zmienia aktywnego stanu budżetu.
Stare budżety bez aktywnej rewizji nadal odczytują dotychczasowe kolekcje.

Historia członkostw z pliku służy wyłącznie do mapowania referencji autorów.
Backend mapuje tożsamość ponownie względem aktywnych członkostw w budżecie
docelowym. Nie tworzy członkostw ani dostępu na podstawie kopii; członkowie
niezweryfikowani są anonimizowani. Scalenie zachowuje rekordy niekolidujące,
a każdy konflikt wymaga osobnego wyboru użytkownika.

Przed odtwarzaniem aplikacja zapisuje lokalną kopię aktualnego stanu. Oryginały
wyciągów są przywracane do lokalnego katalogu urządzenia przed aktywacją
rewizji; błąd ich zapisu przerywa operację przed zmianą aktywnych danych
budżetu. Jeśli aktywacja chmurowa nie powiedzie się już po skopiowaniu plików,
nowe kopie plików mogą pozostać lokalnie; interfejs informuje o tym osobno.
Nie zmienia to aktywnych danych budżetu. Pliki nie są synchronizowane.

## Usuwanie i zakres lokalnych kopii

Usunięcie profilu lub budżetu nie usuwa plików kopii zapisanych przez
użytkownika poza katalogiem aplikacji. Przed usunięciem interfejs przypomina,
że trzeba skasować je osobno. Oryginalne wyciągi przechowywane w katalogu
danych aplikacji są lokalne dla urządzenia i nie są udostępniane innym
członkom.
