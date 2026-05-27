/*
 * Mozai i18n.
 *
 * Lightweight: a single flat strings table keyed by language, ~14
 * strings × 50 languages. No external framework, no separate locale
 * files — Vite tree-shakes the unused branches at build time but
 * even fully shipped this is well under 30 KB minified.
 *
 * Locale resolution at module load:
 *   1. Read navigator.language (the OS / browser locale).
 *   2. Match the FULL tag first (`pt-BR`, `zh-TW`) — exact matches
 *      win because they pick the regional dialect when one is
 *      provided.
 *   3. Fall back to the BASE language (`pt`, `zh`) so a
 *      Brazilian-Portuguese device that doesn't have a `pt-BR` entry
 *      gets the generic `pt` strings instead of English.
 *   4. Final fallback: `en`.
 * The resolved tag is exposed via the `lang` constant; the original
 * navigator.language is logged once via diagLog so the chosen
 * locale is visible in the 🐞 popup.
 *
 * RTL: when the resolved language is one of the RTL set
 * (ar / he / fa / ur), `<html dir="rtl">` is set so the few text
 * labels in the UI flow correctly. Most of Mozai is icon/number-
 * based so this is a small effect.
 *
 * `t(key, params?)`:
 *   - returns the localized string
 *   - placeholders use {name} syntax; pass params as a flat
 *     Record<string, string | number>.
 *   - missing locale → fall back to en; missing en → return the
 *     key (so a typo is visible in the UI rather than rendering
 *     as undefined).
 */

import { diagLog } from './error-overlay.js';

// 50-language set. Tags follow BCP-47. Region variants
// (pt-BR, zh-CN, zh-TW, nb) sit ALONGSIDE their base tags so
// detectLang() can pick a regional dialect when the device's
// navigator.language is regional.
export type Lang =
  | 'en'
  | 'es' | 'fr' | 'de' | 'it'
  | 'pt' | 'pt-BR'
  | 'ru' | 'uk' | 'pl' | 'cs' | 'sk' | 'ro' | 'hu' | 'bg'
  | 'hr' | 'sr' | 'sl'
  | 'nl' | 'sv' | 'da' | 'nb' | 'fi'
  | 'el' | 'tr'
  | 'ja' | 'ko'
  | 'zh-CN' | 'zh-TW'
  | 'ar' | 'he' | 'fa' | 'ur'
  | 'hi' | 'bn' | 'ta' | 'te' | 'mr' | 'ml' | 'gu' | 'kn' | 'pa'
  | 'id' | 'ms' | 'vi' | 'th' | 'fil'
  | 'sw' | 'af' | 'ca';

const RTL_LANGS = new Set<Lang>(['ar', 'he', 'fa', 'ur']);

function detectLang(): Lang {
  const raw = (navigator.language || 'en').trim();
  if (!raw) return 'en';
  // 1. Full tag exact match.
  const normalized = normalizeTag(raw);
  if (normalized in STRINGS_ROOM) return normalized as Lang;
  // 2. Base language.
  const base = raw.split('-')[0].toLowerCase();
  if (base in STRINGS_ROOM) return base as Lang;
  // 3. Fallback.
  return 'en';
}

/**
 * Normalize a BCP-47 tag to the casing the STRINGS keys use:
 * lower-case language + upper-case region (e.g. `pt-br` → `pt-BR`).
 */
function normalizeTag(tag: string): string {
  const parts = tag.split('-');
  if (parts.length === 1) return parts[0].toLowerCase();
  const lc = parts[0].toLowerCase();
  const region = parts[1].toUpperCase();
  // Handle 3-char Chinese variants like zh-Hans / zh-Hant by mapping
  // to the regional forms we ship (zh-Hans → zh-CN, zh-Hant → zh-TW).
  if (lc === 'zh') {
    if (region === 'HANS' || region === 'CN' || region === 'SG') return 'zh-CN';
    if (region === 'HANT' || region === 'TW' || region === 'HK' || region === 'MO') return 'zh-TW';
  }
  return `${lc}-${region}`;
}

// ---- Strings table ----
//
// Each entry is a key whose value is a Partial<Record<Lang, string>>.
// Keeping each key as its own constant (vs one giant nested object)
// lets Vite tree-shake unused keys if any are removed later, and
// makes per-key diffs cleaner in code review when a translator
// updates a single string. The PartialRecord allows leaving a
// language unset; t() falls back to en.
//
// Translation philosophy:
//   - Short, natural words. UI labels are 1-3 chars in many CJK
//     scripts, e.g. ja/zh "完了" (Done) is shorter than the English.
//   - We don't ship "perfect" translations for every dialect — a
//     few are reasonable approximations. Native-speaker review is
//     welcome; the table format makes those updates a one-line
//     diff.

type LangMap = Partial<Record<Lang, string>>;

const STRINGS_ROOM: LangMap = {
  en: 'Room', es: 'Sala', fr: 'Salle', de: 'Raum', it: 'Stanza',
  pt: 'Sala', 'pt-BR': 'Sala',
  ru: 'Зал', uk: 'Кімната', pl: 'Pokój', cs: 'Místnost', sk: 'Miestnosť',
  ro: 'Cameră', hu: 'Szoba', bg: 'Стая',
  hr: 'Soba', sr: 'Соба', sl: 'Soba',
  nl: 'Kamer', sv: 'Rum', da: 'Rum', nb: 'Rom', fi: 'Huone',
  el: 'Δωμάτιο', tr: 'Oda',
  ja: 'ルーム', ko: '룸',
  'zh-CN': '房间', 'zh-TW': '房間',
  ar: 'غرفة', he: 'חדר', fa: 'اتاق', ur: 'کمرہ',
  hi: 'कमरा', bn: 'কক্ষ', ta: 'அறை', te: 'గది',
  mr: 'खोली', ml: 'മുറി', gu: 'ઓરડો', kn: 'ಕೋಣೆ', pa: 'ਕਮਰਾ',
  id: 'Ruang', ms: 'Bilik', vi: 'Phòng', th: 'ห้อง', fil: 'Kuwarto',
  sw: 'Chumba', af: 'Kamer', ca: 'Sala',
};

const STRINGS_CHOOSE_ROOM: LangMap = {
  en: 'Choose a room', es: 'Elige una sala', fr: 'Choisis une salle',
  de: 'Wähle einen Raum', it: 'Scegli una stanza',
  pt: 'Escolhe uma sala', 'pt-BR': 'Escolha uma sala',
  ru: 'Выберите зал', uk: 'Оберіть кімнату', pl: 'Wybierz pokój',
  cs: 'Vyber místnost', sk: 'Vyber miestnosť',
  ro: 'Alege o cameră', hu: 'Válassz szobát', bg: 'Избери стая',
  hr: 'Odaberi sobu', sr: 'Изаберите собу', sl: 'Izberi sobo',
  nl: 'Kies een kamer', sv: 'Välj ett rum', da: 'Vælg et rum',
  nb: 'Velg et rom', fi: 'Valitse huone',
  el: 'Επίλεξε δωμάτιο', tr: 'Bir oda seç',
  ja: 'ルームを選ぶ', ko: '룸 선택',
  'zh-CN': '选择房间', 'zh-TW': '選擇房間',
  ar: 'اختر غرفة', he: 'בחר חדר', fa: 'یک اتاق انتخاب کنید', ur: 'کمرہ منتخب کریں',
  hi: 'कमरा चुनें', bn: 'একটি কক্ষ বাছুন', ta: 'அறை தேர்வுசெய்க',
  te: 'గది ఎంచుకోండి', mr: 'खोली निवडा', ml: 'ഒരു മുറി തിരഞ്ഞെടുക്കുക',
  gu: 'ઓરડો પસંદ કરો', kn: 'ಕೋಣೆ ಆಯ್ಕೆಮಾಡಿ', pa: 'ਇੱਕ ਕਮਰਾ ਚੁਣੋ',
  id: 'Pilih ruang', ms: 'Pilih bilik', vi: 'Chọn một phòng',
  th: 'เลือกห้อง', fil: 'Pumili ng kuwarto',
  sw: 'Chagua chumba', af: 'Kies ’n kamer', ca: 'Tria una sala',
};

const STRINGS_LOADING_PICTURES: LangMap = {
  en: 'Loading pictures…', es: 'Cargando imágenes…', fr: 'Chargement des images…',
  de: 'Bilder werden geladen…', it: 'Caricamento immagini…',
  pt: 'A carregar imagens…', 'pt-BR': 'Carregando imagens…',
  ru: 'Загрузка изображений…', uk: 'Завантаження зображень…',
  pl: 'Wczytywanie obrazów…', cs: 'Načítání obrázků…', sk: 'Načítavanie obrázkov…',
  ro: 'Se încarcă imaginile…', hu: 'Képek betöltése…', bg: 'Зареждане на изображения…',
  hr: 'Učitavanje slika…', sr: 'Учитавање слика…', sl: 'Nalaganje slik…',
  nl: 'Afbeeldingen laden…', sv: 'Laddar bilder…', da: 'Indlæser billeder…',
  nb: 'Laster bilder…', fi: 'Ladataan kuvia…',
  el: 'Φόρτωση εικόνων…', tr: 'Resimler yükleniyor…',
  ja: '画像を読み込み中…', ko: '그림 불러오는 중…',
  'zh-CN': '正在加载图片…', 'zh-TW': '正在載入圖片…',
  ar: 'جارٍ تحميل الصور…', he: 'טוען תמונות…', fa: 'در حال بارگذاری تصاویر…', ur: 'تصاویر لوڈ ہو رہی ہیں…',
  hi: 'चित्र लोड हो रहे हैं…', bn: 'ছবি লোড হচ্ছে…', ta: 'படங்கள் ஏற்றப்படுகின்றன…',
  te: 'చిత్రాలు లోడ్ అవుతున్నాయి…', mr: 'चित्रे लोड होत आहेत…',
  ml: 'ചിത്രങ്ങൾ ലോഡ് ചെയ്യുന്നു…', gu: 'ચિત્રો લોડ થઈ રહ્યાં છે…',
  kn: 'ಚಿತ್ರಗಳು ಲೋಡ್ ಆಗುತ್ತಿವೆ…', pa: 'ਚਿੱਤਰ ਲੋਡ ਹੋ ਰਹੇ ਹਨ…',
  id: 'Memuat gambar…', ms: 'Memuatkan gambar…', vi: 'Đang tải hình ảnh…',
  th: 'กำลังโหลดภาพ…', fil: 'Naglo-load ng mga larawan…',
  sw: 'Inapakia picha…', af: 'Laai prente…', ca: 'S’estan carregant les imatges…',
};

const STRINGS_LOADING_PUZZLE: LangMap = {
  en: 'Loading puzzle…', es: 'Cargando rompecabezas…', fr: 'Chargement du puzzle…',
  de: 'Lade Puzzle…', it: 'Caricamento del puzzle…',
  pt: 'A carregar puzzle…', 'pt-BR': 'Carregando quebra-cabeça…',
  ru: 'Загрузка пазла…', uk: 'Завантаження пазла…',
  pl: 'Wczytywanie układanki…', cs: 'Načítání skládačky…', sk: 'Načítavanie skladačky…',
  ro: 'Se încarcă puzzle-ul…', hu: 'Kirakó betöltése…', bg: 'Зареждане на пъзел…',
  hr: 'Učitavanje slagalice…', sr: 'Учитавање слагалице…', sl: 'Nalaganje sestavljanke…',
  nl: 'Puzzel laden…', sv: 'Laddar pussel…', da: 'Indlæser puslespil…',
  nb: 'Laster puslespill…', fi: 'Ladataan palapeliä…',
  el: 'Φόρτωση παζλ…', tr: 'Yapboz yükleniyor…',
  ja: 'パズルを読み込み中…', ko: '퍼즐 불러오는 중…',
  'zh-CN': '正在加载拼图…', 'zh-TW': '正在載入拼圖…',
  ar: 'جارٍ تحميل اللغز…', he: 'טוען פאזל…', fa: 'در حال بارگذاری پازل…', ur: 'پزل لوڈ ہو رہا ہے…',
  hi: 'पहेली लोड हो रही है…', bn: 'ধাঁধা লোড হচ্ছে…', ta: 'புதிர் ஏற்றப்படுகிறது…',
  te: 'పజిల్ లోడ్ అవుతోంది…', mr: 'कोडे लोड होत आहे…',
  ml: 'പസിൽ ലോഡ് ചെയ്യുന്നു…', gu: 'કોયડો લોડ થઈ રહ્યો છે…',
  kn: 'ಪಜಲ್ ಲೋಡ್ ಆಗುತ್ತಿದೆ…', pa: 'ਪਹੇਲੀ ਲੋਡ ਹੋ ਰਹੀ ਹੈ…',
  id: 'Memuat teka-teki…', ms: 'Memuatkan teka-teki…', vi: 'Đang tải câu đố…',
  th: 'กำลังโหลดปริศนา…', fil: 'Naglo-load ng palaisipan…',
  sw: 'Inapakia fumbo…', af: 'Laai legkaart…', ca: 'S’està carregant el trencaclosques…',
};

const STRINGS_NO_PICTURES_YET: LangMap = {
  en: 'No pictures in this room yet.', es: 'Aún no hay imágenes en esta sala.',
  fr: 'Aucune image dans cette salle.', de: 'Noch keine Bilder in diesem Raum.',
  it: 'Ancora nessuna immagine in questa stanza.',
  pt: 'Ainda sem imagens nesta sala.', 'pt-BR': 'Ainda não há imagens nesta sala.',
  ru: 'В этом зале пока нет изображений.', uk: 'У цій кімнаті ще немає зображень.',
  pl: 'W tym pokoju nie ma jeszcze obrazów.', cs: 'V této místnosti zatím nejsou obrázky.',
  sk: 'V tejto miestnosti zatiaľ nie sú obrázky.',
  ro: 'Nicio imagine în această cameră încă.', hu: 'Ebben a szobában még nincsenek képek.',
  bg: 'Все още няма изображения в тази стая.',
  hr: 'Još nema slika u ovoj sobi.', sr: 'Још нема слика у овој соби.',
  sl: 'V tej sobi še ni slik.',
  nl: 'Nog geen afbeeldingen in deze kamer.', sv: 'Inga bilder i det här rummet än.',
  da: 'Ingen billeder i dette rum endnu.', nb: 'Ingen bilder i dette rommet ennå.',
  fi: 'Tässä huoneessa ei vielä ole kuvia.',
  el: 'Δεν υπάρχουν εικόνες σε αυτό το δωμάτιο.', tr: 'Bu odada henüz resim yok.',
  ja: 'このルームにはまだ画像がありません。', ko: '이 룸에는 아직 그림이 없습니다.',
  'zh-CN': '这个房间还没有图片。', 'zh-TW': '這個房間還沒有圖片。',
  ar: 'لا توجد صور في هذه الغرفة بعد.', he: 'אין עדיין תמונות בחדר זה.',
  fa: 'هنوز هیچ تصویری در این اتاق نیست.', ur: 'اس کمرے میں ابھی کوئی تصویر نہیں ہے۔',
  hi: 'इस कमरे में अभी कोई चित्र नहीं।', bn: 'এই কক্ষে এখনও কোনও ছবি নেই।',
  ta: 'இந்த அறையில் இன்னும் படங்கள் இல்லை.', te: 'ఈ గదిలో ఇంకా చిత్రాలు లేవు.',
  mr: 'या खोलीत अद्याप चित्रे नाहीत.', ml: 'ഈ മുറിയിൽ ഇതുവരെ ചിത്രങ്ങൾ ഇല്ല.',
  gu: 'આ ઓરડામાં હજુ ચિત્રો નથી.', kn: 'ಈ ಕೋಣೆಯಲ್ಲಿ ಇನ್ನೂ ಚಿತ್ರಗಳಿಲ್ಲ.',
  pa: 'ਇਸ ਕਮਰੇ ਵਿੱਚ ਅਜੇ ਚਿੱਤਰ ਨਹੀਂ ਹਨ।',
  id: 'Belum ada gambar di ruang ini.', ms: 'Belum ada gambar dalam bilik ini.',
  vi: 'Chưa có hình ảnh trong phòng này.', th: 'ยังไม่มีภาพในห้องนี้',
  fil: 'Wala pang larawan sa kuwartong ito.',
  sw: 'Hakuna picha katika chumba hiki bado.', af: 'Nog geen prente in hierdie kamer nie.',
  ca: 'Encara no hi ha imatges en aquesta sala.',
};

const STRINGS_COULD_NOT_LOAD_THUMBS: LangMap = {
  en: 'Could not load room {n} thumbnails.',
  es: 'No se pueden cargar las miniaturas de la sala {n}.',
  fr: 'Impossible de charger les miniatures de la salle {n}.',
  de: 'Vorschaubilder für Raum {n} konnten nicht geladen werden.',
  it: 'Impossibile caricare le miniature della stanza {n}.',
  pt: 'Não foi possível carregar as miniaturas da sala {n}.',
  'pt-BR': 'Não foi possível carregar as miniaturas da sala {n}.',
  ru: 'Не удалось загрузить миниатюры зала {n}.', uk: 'Не вдалося завантажити мініатюри кімнати {n}.',
  pl: 'Nie można wczytać miniatur pokoju {n}.',
  cs: 'Nelze načíst náhledy místnosti {n}.', sk: 'Nedajú sa načítať náhľady miestnosti {n}.',
  ro: 'Miniaturile camerei {n} nu pot fi încărcate.', hu: 'A(z) {n}. szoba miniatűrjei nem tölthetők be.',
  bg: 'Не могат да се заредят миниатюрите на стая {n}.',
  hr: 'Nije moguće učitati sličice sobe {n}.', sr: 'Није могуће учитати минијатуре собе {n}.',
  sl: 'Sličic sobe {n} ni mogoče naložiti.',
  nl: 'Kan miniaturen van kamer {n} niet laden.', sv: 'Kan inte ladda miniatyrer för rum {n}.',
  da: 'Kan ikke indlæse miniaturer for rum {n}.', nb: 'Kan ikke laste miniatyrer for rom {n}.',
  fi: 'Huoneen {n} pienoiskuvia ei voi ladata.',
  el: 'Δεν ήταν δυνατή η φόρτωση των μικρογραφιών του δωματίου {n}.',
  tr: '{n}. odanın küçük resimleri yüklenemedi.',
  ja: 'ルーム {n} のサムネイルを読み込めませんでした。',
  ko: '룸 {n}의 미리보기를 불러올 수 없습니다.',
  'zh-CN': '无法加载房间 {n} 的缩略图。', 'zh-TW': '無法載入房間 {n} 的縮圖。',
  ar: 'تعذّر تحميل صور مصغّرة للغرفة {n}.', he: 'לא ניתן לטעון תמונות ממוזערות לחדר {n}.',
  fa: 'نمی‌توان تصاویر کوچک اتاق {n} را بارگذاری کرد.',
  ur: 'کمرہ {n} کے تھمب نیلز لوڈ نہیں ہو سکے۔',
  hi: 'कमरा {n} के थंबनेल लोड नहीं हो सके।', bn: 'কক্ষ {n}-এর থাম্বনেইল লোড করা যায়নি।',
  ta: 'அறை {n}-இன் சிறுபடங்கள் ஏற்ற முடியவில்லை.',
  te: 'గది {n} థంబ్‌నెయిల్‌లు లోడ్ చేయలేకపోయాము.',
  mr: 'खोली {n} ची थंबनेल लोड होऊ शकली नाहीत.',
  ml: 'മുറി {n}-ന്റെ ലഘുചിത്രങ്ങൾ ലോഡ് ചെയ്യാനായില്ല.',
  gu: 'ઓરડો {n} ના થમ્બનેઇલ લોડ થઈ શક્યા નહીં.',
  kn: 'ಕೋಣೆ {n} ರ ಥಂಬ್‌ನೇಲ್‌ಗಳನ್ನು ಲೋಡ್ ಮಾಡಲಾಗಲಿಲ್ಲ.',
  pa: 'ਕਮਰਾ {n} ਦੇ ਥੰਬਨੇਲ ਲੋਡ ਨਹੀਂ ਹੋ ਸਕੇ।',
  id: 'Tidak dapat memuat thumbnail ruang {n}.', ms: 'Tidak dapat memuatkan lakaran kecil bilik {n}.',
  vi: 'Không thể tải hình thu nhỏ của phòng {n}.', th: 'ไม่สามารถโหลดภาพย่อของห้อง {n} ได้',
  fil: 'Hindi ma-load ang mga thumbnail ng kuwarto {n}.',
  sw: 'Imeshindwa kupakia vijipicha vya chumba {n}.',
  af: 'Kon nie duimnaelsketse vir kamer {n} laai nie.',
  ca: 'No s’han pogut carregar les miniatures de la sala {n}.',
};

const STRINGS_COULD_NOT_LOAD_PUZZLE: LangMap = {
  en: 'Could not load puzzle {id}.',
  es: 'No se pudo cargar el rompecabezas {id}.', fr: 'Impossible de charger le puzzle {id}.',
  de: 'Puzzle {id} konnte nicht geladen werden.', it: 'Impossibile caricare il puzzle {id}.',
  pt: 'Não foi possível carregar o puzzle {id}.', 'pt-BR': 'Não foi possível carregar o quebra-cabeça {id}.',
  ru: 'Не удалось загрузить пазл {id}.', uk: 'Не вдалося завантажити пазл {id}.',
  pl: 'Nie można wczytać układanki {id}.', cs: 'Nelze načíst skládačku {id}.',
  sk: 'Nedá sa načítať skladačka {id}.',
  ro: 'Nu se poate încărca puzzle-ul {id}.', hu: 'A(z) {id} kirakó nem tölthető be.',
  bg: 'Не може да се зареди пъзел {id}.',
  hr: 'Nije moguće učitati slagalicu {id}.', sr: 'Није могуће учитати слагалицу {id}.',
  sl: 'Sestavljanke {id} ni mogoče naložiti.',
  nl: 'Kan puzzel {id} niet laden.', sv: 'Kan inte ladda pussel {id}.',
  da: 'Kan ikke indlæse puslespil {id}.', nb: 'Kan ikke laste puslespill {id}.',
  fi: 'Palapeliä {id} ei voi ladata.',
  el: 'Δεν ήταν δυνατή η φόρτωση του παζλ {id}.', tr: '{id} yapbozu yüklenemedi.',
  ja: 'パズル {id} を読み込めませんでした。', ko: '퍼즐 {id}를 불러올 수 없습니다.',
  'zh-CN': '无法加载拼图 {id}。', 'zh-TW': '無法載入拼圖 {id}。',
  ar: 'تعذّر تحميل اللغز {id}.', he: 'לא ניתן לטעון פאזל {id}.',
  fa: 'نمی‌توان پازل {id} را بارگذاری کرد.', ur: 'پزل {id} لوڈ نہیں ہو سکا۔',
  hi: 'पहेली {id} लोड नहीं हो सकी।', bn: 'ধাঁধা {id} লোড করা যায়নি।',
  ta: 'புதிர் {id} ஐ ஏற்ற முடியவில்லை.', te: 'పజిల్ {id} లోడ్ చేయలేకపోయాము.',
  mr: 'कोडे {id} लोड होऊ शकले नाही.', ml: 'പസിൽ {id} ലോഡ് ചെയ്യാനായില്ല.',
  gu: 'કોયડો {id} લોડ થઈ શક્યો નહીં.', kn: 'ಪಜಲ್ {id} ಲೋಡ್ ಮಾಡಲಾಗಲಿಲ್ಲ.',
  pa: 'ਪਹੇਲੀ {id} ਲੋਡ ਨਹੀਂ ਹੋ ਸਕੀ।',
  id: 'Tidak dapat memuat teka-teki {id}.', ms: 'Tidak dapat memuatkan teka-teki {id}.',
  vi: 'Không thể tải câu đố {id}.', th: 'ไม่สามารถโหลดปริศนา {id} ได้',
  fil: 'Hindi ma-load ang palaisipan {id}.',
  sw: 'Imeshindwa kupakia fumbo {id}.', af: 'Kon nie legkaart {id} laai nie.',
  ca: 'No s’ha pogut carregar el trencaclosques {id}.',
};

const STRINGS_RETRY: LangMap = {
  en: 'Retry', es: 'Reintentar', fr: 'Réessayer', de: 'Erneut versuchen',
  it: 'Riprova', pt: 'Tentar de novo', 'pt-BR': 'Tentar de novo',
  ru: 'Повторить', uk: 'Повторити', pl: 'Spróbuj ponownie',
  cs: 'Zkusit znovu', sk: 'Skúsiť znova',
  ro: 'Reîncearcă', hu: 'Újra', bg: 'Опитай отново',
  hr: 'Pokušaj ponovo', sr: 'Покушај поново', sl: 'Poskusi znova',
  nl: 'Opnieuw', sv: 'Försök igen', da: 'Prøv igen', nb: 'Prøv igjen',
  fi: 'Yritä uudelleen',
  el: 'Ξανά', tr: 'Tekrar dene',
  ja: '再試行', ko: '다시 시도',
  'zh-CN': '重试', 'zh-TW': '重試',
  ar: 'إعادة المحاولة', he: 'נסה שוב', fa: 'تلاش مجدد', ur: 'دوبارہ کوشش',
  hi: 'पुनः प्रयास', bn: 'আবার চেষ্টা', ta: 'மீண்டும் முயற்சி',
  te: 'మళ్లీ ప్రయత్నించండి', mr: 'पुन्हा प्रयत्न', ml: 'വീണ്ടും ശ്രമിക്കുക',
  gu: 'ફરી પ્રયાસ', kn: 'ಮತ್ತೆ ಪ್ರಯತ್ನಿಸಿ', pa: 'ਮੁੜ ਕੋਸ਼ਿਸ਼',
  id: 'Coba lagi', ms: 'Cuba lagi', vi: 'Thử lại', th: 'ลองอีกครั้ง', fil: 'Subukang muli',
  sw: 'Jaribu tena', af: 'Probeer weer', ca: 'Torna-ho a provar',
};

const STRINGS_HINT: LangMap = {
  en: 'Hint', es: 'Pista', fr: 'Indice', de: 'Tipp', it: 'Suggerimento',
  pt: 'Dica', 'pt-BR': 'Dica',
  ru: 'Подсказка', uk: 'Підказка', pl: 'Wskazówka',
  cs: 'Nápověda', sk: 'Pomôcka',
  ro: 'Sugestie', hu: 'Tipp', bg: 'Подсказка',
  hr: 'Savjet', sr: 'Савет', sl: 'Namig',
  nl: 'Hint', sv: 'Tips', da: 'Tip', nb: 'Tips', fi: 'Vihje',
  el: 'Βοήθεια', tr: 'İpucu',
  ja: 'ヒント', ko: '힌트',
  'zh-CN': '提示', 'zh-TW': '提示',
  ar: 'تلميح', he: 'רמז', fa: 'راهنما', ur: 'اشارہ',
  hi: 'संकेत', bn: 'ইঙ্গিত', ta: 'குறிப்பு', te: 'సూచన',
  mr: 'सूचना', ml: 'സൂചന', gu: 'સંકેત', kn: 'ಸುಳಿವು', pa: 'ਸੰਕੇਤ',
  id: 'Petunjuk', ms: 'Petunjuk', vi: 'Gợi ý', th: 'คำใบ้', fil: 'Pahiwatig',
  sw: 'Dokezo', af: 'Wenk', ca: 'Pista',
};

const STRINGS_HINTED: LangMap = {
  en: 'Hinted', es: 'Pista usada', fr: 'Indice utilisé', de: 'Tipp genutzt',
  it: 'Già rivelato', pt: 'Dica usada', 'pt-BR': 'Dica usada',
  ru: 'Подсказано', uk: 'Підказано', pl: 'Użyto',
  cs: 'Použito', sk: 'Použité',
  ro: 'Utilizat', hu: 'Felhasználva', bg: 'Използвано',
  hr: 'Iskorišteno', sr: 'Искоришћено', sl: 'Uporabljeno',
  nl: 'Gebruikt', sv: 'Använt', da: 'Brugt', nb: 'Brukt', fi: 'Käytetty',
  el: 'Χρησιμοποιήθηκε', tr: 'Gösterildi',
  ja: 'ヒント済', ko: '힌트 사용됨',
  'zh-CN': '已提示', 'zh-TW': '已提示',
  ar: 'تم التلميح', he: 'נחשף', fa: 'استفاده شد', ur: 'استعمال ہوا',
  hi: 'दिया गया', bn: 'দেখানো হয়েছে', ta: 'பயன்படுத்தப்பட்டது',
  te: 'ఉపయోగించారు', mr: 'वापरली', ml: 'ഉപയോഗിച്ചു', gu: 'વાપરી', kn: 'ಬಳಸಲಾಗಿದೆ',
  pa: 'ਵਰਤਿਆ ਗਿਆ',
  id: 'Sudah dipakai', ms: 'Sudah digunakan', vi: 'Đã dùng', th: 'ใช้แล้ว', fil: 'Nagamit na',
  sw: 'Imetumika', af: 'Gebruik', ca: 'Pista usada',
};

const STRINGS_DONE: LangMap = {
  en: 'Done', es: 'Listo', fr: 'OK', de: 'Fertig', it: 'Fatto',
  pt: 'Concluído', 'pt-BR': 'Concluído',
  ru: 'Готово', uk: 'Готово', pl: 'Gotowe', cs: 'Hotovo', sk: 'Hotovo',
  ro: 'Gata', hu: 'Kész', bg: 'Готово',
  hr: 'Gotovo', sr: 'Готово', sl: 'Končano',
  nl: 'Klaar', sv: 'Klar', da: 'Færdig', nb: 'Ferdig', fi: 'Valmis',
  el: 'Έγινε', tr: 'Tamam',
  ja: '完了', ko: '완료',
  'zh-CN': '完成', 'zh-TW': '完成',
  ar: 'تم', he: 'סיום', fa: 'انجام شد', ur: 'مکمل',
  hi: 'पूर्ण', bn: 'হয়ে গেছে', ta: 'முடிந்தது', te: 'పూర్తయింది',
  mr: 'पूर्ण', ml: 'പൂർത്തിയായി', gu: 'પૂર્ણ', kn: 'ಮುಗಿಯಿತು', pa: 'ਮੁਕੰਮਲ',
  id: 'Selesai', ms: 'Selesai', vi: 'Xong', th: 'เสร็จสิ้น', fil: 'Tapos',
  sw: 'Imekamilika', af: 'Klaar', ca: 'Fet',
};

const STRINGS_COMPLETE_TITLE: LangMap = {
  en: 'Complete!', es: '¡Completo!', fr: 'Terminé !', de: 'Geschafft!',
  it: 'Completato!', pt: 'Completo!', 'pt-BR': 'Concluído!',
  ru: 'Готово!', uk: 'Завершено!', pl: 'Ukończono!',
  cs: 'Hotovo!', sk: 'Hotovo!',
  ro: 'Finalizat!', hu: 'Kész!', bg: 'Готово!',
  hr: 'Gotovo!', sr: 'Готово!', sl: 'Končano!',
  nl: 'Voltooid!', sv: 'Klart!', da: 'Færdig!', nb: 'Ferdig!', fi: 'Valmis!',
  el: 'Ολοκληρώθηκε!', tr: 'Tamamlandı!',
  ja: '完成!', ko: '완성!',
  'zh-CN': '完成!', 'zh-TW': '完成!',
  ar: 'مكتمل!', he: 'הושלם!', fa: 'تکمیل شد!', ur: 'مکمل!',
  hi: 'पूरा हुआ!', bn: 'সম্পন্ন!', ta: 'முடிந்தது!', te: 'పూర్తైంది!',
  mr: 'पूर्ण!', ml: 'പൂർത്തിയായി!', gu: 'પૂર્ણ!', kn: 'ಪೂರ್ಣ!',
  pa: 'ਮੁਕੰਮਲ!',
  id: 'Selesai!', ms: 'Siap!', vi: 'Hoàn thành!', th: 'สำเร็จ!', fil: 'Tapos na!',
  sw: 'Imekamilika!', af: 'Voltooi!', ca: 'Completat!',
};

const STRINGS_COMPLETE_FINISHED: LangMap = {
  en: 'You finished {name}.', es: 'Has terminado {name}.', fr: 'Tu as terminé {name}.',
  de: 'Du hast {name} geschafft.', it: 'Hai completato {name}.',
  pt: 'Acabaste {name}.', 'pt-BR': 'Você concluiu {name}.',
  ru: 'Вы завершили {name}.', uk: 'Ви завершили {name}.',
  pl: 'Ukończono {name}.', cs: 'Dokončili jste {name}.', sk: 'Dokončili ste {name}.',
  ro: 'Ai finalizat {name}.', hu: 'Befejezted: {name}.', bg: 'Завърши {name}.',
  hr: 'Završio si {name}.', sr: 'Завршили сте {name}.', sl: 'Končal/a si {name}.',
  nl: 'Je hebt {name} voltooid.', sv: 'Du klarade {name}.',
  da: 'Du gennemførte {name}.', nb: 'Du fullførte {name}.', fi: 'Suoritit kohteen {name}.',
  el: 'Ολοκλήρωσες το {name}.', tr: '{name} tamamlandı.',
  ja: '{name} を完成しました。', ko: '{name}을(를) 완성했습니다.',
  'zh-CN': '你完成了 {name}。', 'zh-TW': '你完成了 {name}。',
  ar: 'لقد أكملت {name}.', he: 'סיימת את {name}.',
  fa: 'شما {name} را تکمیل کردید.', ur: 'آپ نے {name} مکمل کر لیا۔',
  hi: 'आपने {name} पूरा किया।', bn: 'আপনি {name} সম্পন্ন করেছেন।',
  ta: 'நீங்கள் {name} முடித்துவிட்டீர்கள்.',
  te: 'మీరు {name} పూర్తి చేశారు.', mr: 'तुम्ही {name} पूर्ण केले.',
  ml: 'നിങ്ങൾ {name} പൂർത്തിയാക്കി.', gu: 'તમે {name} પૂર્ણ કર્યું.',
  kn: 'ನೀವು {name} ಮುಗಿಸಿದ್ದೀರಿ.', pa: 'ਤੁਸੀਂ {name} ਮੁਕੰਮਲ ਕੀਤਾ।',
  id: 'Kamu menyelesaikan {name}.', ms: 'Awak siapkan {name}.',
  vi: 'Bạn đã hoàn thành {name}.', th: 'คุณทำ {name} สำเร็จ',
  fil: 'Natapos mo ang {name}.',
  sw: 'Umemaliza {name}.', af: 'Jy het {name} voltooi.',
  ca: 'Has acabat {name}.',
};

const STRINGS_DONE_BADGE: LangMap = {
  en: '✓ Done', es: '✓ Listo', fr: '✓ OK', de: '✓ Fertig', it: '✓ Fatto',
  pt: '✓ Concluído', 'pt-BR': '✓ Concluído',
  ru: '✓ Готово', uk: '✓ Готово', pl: '✓ Gotowe', cs: '✓ Hotovo', sk: '✓ Hotovo',
  ro: '✓ Gata', hu: '✓ Kész', bg: '✓ Готово',
  hr: '✓ Gotovo', sr: '✓ Готово', sl: '✓ Končano',
  nl: '✓ Klaar', sv: '✓ Klart', da: '✓ Færdig', nb: '✓ Ferdig', fi: '✓ Valmis',
  el: '✓ Έτοιμο', tr: '✓ Bitti',
  ja: '✓ 完了', ko: '✓ 완료',
  'zh-CN': '✓ 完成', 'zh-TW': '✓ 完成',
  ar: '✓ تم', he: '✓ הושלם', fa: '✓ انجام شد', ur: '✓ مکمل',
  hi: '✓ पूर्ण', bn: '✓ সম্পন্ন', ta: '✓ முடிந்தது', te: '✓ పూర్తి',
  mr: '✓ पूर्ण', ml: '✓ പൂർത്തി', gu: '✓ પૂર્ણ', kn: '✓ ಮುಗಿಯಿತು', pa: '✓ ਮੁਕੰਮਲ',
  id: '✓ Selesai', ms: '✓ Siap', vi: '✓ Hoàn tất', th: '✓ เสร็จ', fil: '✓ Tapos',
  sw: '✓ Imekamilika', af: '✓ Klaar', ca: '✓ Fet',
};

// One lookup table to make iteration easy.
type StringKey =
  | 'room' | 'chooseRoom' | 'loadingPictures' | 'loadingPuzzle'
  | 'noPicturesYet' | 'couldNotLoadThumbs' | 'couldNotLoadPuzzle' | 'retry'
  | 'hint' | 'hinted' | 'done' | 'completeTitle' | 'completeFinished' | 'doneBadge';

const TABLE: Record<StringKey, LangMap> = {
  room: STRINGS_ROOM,
  chooseRoom: STRINGS_CHOOSE_ROOM,
  loadingPictures: STRINGS_LOADING_PICTURES,
  loadingPuzzle: STRINGS_LOADING_PUZZLE,
  noPicturesYet: STRINGS_NO_PICTURES_YET,
  couldNotLoadThumbs: STRINGS_COULD_NOT_LOAD_THUMBS,
  couldNotLoadPuzzle: STRINGS_COULD_NOT_LOAD_PUZZLE,
  retry: STRINGS_RETRY,
  hint: STRINGS_HINT,
  hinted: STRINGS_HINTED,
  done: STRINGS_DONE,
  completeTitle: STRINGS_COMPLETE_TITLE,
  completeFinished: STRINGS_COMPLETE_FINISHED,
  doneBadge: STRINGS_DONE_BADGE,
};

export const lang: Lang = detectLang();

// Boot diag + html lang/dir setup. Runs at module import so it's
// done before any UI string is rendered.
{
  const rtl = RTL_LANGS.has(lang);
  if (document.documentElement) {
    document.documentElement.setAttribute('lang', lang);
    document.documentElement.setAttribute('dir', rtl ? 'rtl' : 'ltr');
  }
  diagLog(`i18n: locale=${lang} from=${navigator.language || '(empty)'} rtl=${rtl}`);
}

export function t(key: StringKey, params?: Record<string, string | number>): string {
  const entry = TABLE[key];
  const base = entry[lang] ?? entry.en ?? key;
  if (!params) return base;
  return base.replace(/\{(\w+)\}/g, (_, name) =>
    params[name] !== undefined ? String(params[name]) : `{${name}}`,
  );
}
