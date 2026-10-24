export interface FlagCountry {
  name: string;
  code: string;
  aliases?: string[];
}

export const FLAG_COUNTRIES: FlagCountry[] = [
  { name: "Afghanistan", code: "af" },
  { name: "Albania", code: "al" },
  { name: "Algeria", code: "dz" },
  { name: "Argentina", code: "ar" },
  { name: "Australia", code: "au" },
  { name: "Austria", code: "at" },
  { name: "Azerbaijan", code: "az" },
  { name: "Bangladesh", code: "bd" },
  { name: "Belgium", code: "be" },
  { name: "Bolivia", code: "bo" },
  { name: "Brazil", code: "br" },
  { name: "Bulgaria", code: "bg" },
  { name: "Cambodia", code: "kh" },
  { name: "Cameroon", code: "cm" },
  { name: "Canada", code: "ca" },
  { name: "Chile", code: "cl" },
  { name: "China", code: "cn" },
  { name: "Colombia", code: "co" },
  { name: "Costa Rica", code: "cr" },
  { name: "Croatia", code: "hr" },
  { name: "Cuba", code: "cu" },
  { name: "Cyprus", code: "cy" },
  { name: "Czechia", code: "cz", aliases: ["Czech Republic"] },
  { name: "Denmark", code: "dk" },
  { name: "Dominican Republic", code: "do" },
  { name: "Ecuador", code: "ec" },
  { name: "Egypt", code: "eg" },
  { name: "Finland", code: "fi" },
  { name: "France", code: "fr" },
  { name: "Georgia", code: "ge" },
  { name: "Germany", code: "de" },
  { name: "Ghana", code: "gh" },
  { name: "Greece", code: "gr" },
  { name: "Hungary", code: "hu" },
  { name: "Iceland", code: "is" },
  { name: "India", code: "in" },
  { name: "Indonesia", code: "id" },
  { name: "Iran", code: "ir" },
  { name: "Iraq", code: "iq" },
  { name: "Ireland", code: "ie" },
  { name: "Israel", code: "il" },
  { name: "Italy", code: "it" },
  { name: "Jamaica", code: "jm" },
  { name: "Japan", code: "jp" },
  { name: "Jordan", code: "jo" },
  { name: "Kazakhstan", code: "kz" },
  { name: "Kenya", code: "ke" },
  { name: "Malaysia", code: "my" },
  { name: "Mexico", code: "mx" },
  { name: "Morocco", code: "ma" },
  { name: "Nepal", code: "np" },
  { name: "Netherlands", code: "nl", aliases: ["Holland"] },
  { name: "New Zealand", code: "nz" },
  { name: "Nigeria", code: "ng" },
  { name: "Norway", code: "no" },
  { name: "Pakistan", code: "pk" },
  { name: "Peru", code: "pe" },
  { name: "Philippines", code: "ph" },
  { name: "Poland", code: "pl" },
  { name: "Portugal", code: "pt" },
  { name: "Qatar", code: "qa" },
  { name: "Romania", code: "ro" },
  { name: "Russia", code: "ru" },
  { name: "Saudi Arabia", code: "sa" },
  { name: "Serbia", code: "rs" },
  { name: "Singapore", code: "sg" },
  { name: "South Africa", code: "za" },
  { name: "South Korea", code: "kr", aliases: ["Korea", "Republic of Korea"] },
  { name: "Spain", code: "es" },
  { name: "Sri Lanka", code: "lk" },
  { name: "Sweden", code: "se" },
  { name: "Switzerland", code: "ch" },
  { name: "Taiwan", code: "tw" },
  { name: "Thailand", code: "th" },
  { name: "Türkiye", code: "tr", aliases: ["Turkey"] },
  { name: "Ukraine", code: "ua" },
  { name: "United Arab Emirates", code: "ae", aliases: ["UAE", "Emirates"] },
  { name: "United Kingdom", code: "gb", aliases: ["UK", "Great Britain", "Britain", "England"] },
  { name: "United States", code: "us", aliases: ["US", "USA", "United States of America"] },
  { name: "Uruguay", code: "uy" },
  { name: "Vietnam", code: "vn" },
  { name: "Yemen", code: "ye" },
];

export function normalizeCountryAnswer(answer: string): string {
  return answer
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function findFlagCountry(code: string): FlagCountry | undefined {
  return FLAG_COUNTRIES.find((country) => country.code === code.toLowerCase());
}

export function isCorrectFlagCountryAnswer(code: string, answer: string): boolean {
  const country = findFlagCountry(code);
  if (!country) return false;
  const normalizedAnswer = normalizeCountryAnswer(answer);
  return [country.name, ...(country.aliases ?? [])]
    .some((acceptedAnswer) => normalizeCountryAnswer(acceptedAnswer) === normalizedAnswer);
}