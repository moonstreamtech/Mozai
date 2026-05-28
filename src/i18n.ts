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
 * The resolved tag is exposed via the `lang` constant.
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

const STRINGS_HINT_UNLOCKED: LangMap = {
  en: 'Hint unlocked for this colour.',
  es: 'Pista desbloqueada para este color.',
  fr: 'Indice débloqué pour cette couleur.',
  de: 'Tipp für diese Farbe freigeschaltet.',
  it: 'Suggerimento sbloccato per questo colore.',
  pt: 'Dica desbloqueada para esta cor.',
  'pt-BR': 'Dica desbloqueada para esta cor.',
  ru: 'Подсказка для этого цвета открыта.',
  uk: 'Підказка для цього кольору відкрита.',
  pl: 'Wskazówka odblokowana dla tego koloru.',
  cs: 'Nápověda odemčena pro tuto barvu.',
  sk: 'Pomôcka odomknutá pre túto farbu.',
  ro: 'Sugestie deblocată pentru această culoare.',
  hu: 'Tipp feloldva ehhez a színhez.',
  bg: 'Подсказка отключена за този цвят.',
  hr: 'Savjet otključan za ovu boju.',
  sr: 'Савет откључан за ову боју.',
  sl: 'Namig odklenjen za to barvo.',
  nl: 'Hint vrijgespeeld voor deze kleur.',
  sv: 'Tips upplåst för denna färg.',
  da: 'Tip låst op for denne farve.',
  nb: 'Tips låst opp for denne fargen.',
  fi: 'Vihje avattu tälle värille.',
  el: 'Η βοήθεια ξεκλείδωσε για αυτό το χρώμα.',
  tr: 'Bu renk için ipucu açıldı.',
  ja: 'この色のヒントが解放されました。',
  ko: '이 색상의 힌트가 열렸습니다.',
  'zh-CN': '该颜色的提示已解锁。',
  'zh-TW': '該顏色的提示已解鎖。',
  ar: 'تم فتح التلميح لهذا اللون.',
  he: 'הרמז נפתח עבור הצבע הזה.',
  fa: 'راهنما برای این رنگ فعال شد.',
  ur: 'اس رنگ کے لیے اشارہ کھول دیا گیا۔',
  hi: 'इस रंग के लिए संकेत खुला।',
  bn: 'এই রঙের জন্য ইঙ্গিত খোলা হলো।',
  ta: 'இந்த நிறத்திற்கான குறிப்பு திறக்கப்பட்டது.',
  te: 'ఈ రంగు కోసం సూచన అన్‌లాక్ చేయబడింది.',
  mr: 'या रंगासाठी सूचना उघडली.',
  ml: 'ഈ നിറത്തിന് സൂചന തുറന്നു.',
  gu: 'આ રંગ માટે સંકેત ખુલ્યો.',
  kn: 'ಈ ಬಣ್ಣಕ್ಕೆ ಸುಳಿವು ಅನ್‌ಲಾಕ್ ಆಯಿತು.',
  pa: 'ਇਸ ਰੰਗ ਲਈ ਸੰਕੇਤ ਖੁੱਲ੍ਹ ਗਿਆ।',
  id: 'Petunjuk terbuka untuk warna ini.',
  ms: 'Petunjuk dibuka untuk warna ini.',
  vi: 'Đã mở khóa gợi ý cho màu này.',
  th: 'ปลดล็อกคำใบ้สำหรับสีนี้แล้ว',
  fil: 'Na-unlock ang pahiwatig para sa kulay na ito.',
  sw: 'Dokezo limefunguliwa kwa rangi hii.',
  af: 'Wenk vir hierdie kleur ontsluit.',
  ca: 'Pista desbloquejada per a aquest color.',
};

const STRINGS_ROOM_LOAD_FAILED: LangMap = {
  en: "This room couldn't be loaded. Tap retry.",
  es: 'No se pudo cargar esta sala. Toca para reintentar.',
  fr: 'Impossible de charger cette salle. Touchez pour réessayer.',
  de: 'Dieser Raum konnte nicht geladen werden. Zum Erneutversuchen tippen.',
  it: 'Impossibile caricare questa stanza. Tocca per riprovare.',
  pt: 'Não foi possível carregar esta sala. Toca em tentar novamente.',
  'pt-BR': 'Não foi possível carregar esta sala. Toque em tentar novamente.',
  ru: 'Не удалось загрузить этот зал. Нажмите, чтобы повторить.',
  uk: 'Не вдалося завантажити цю кімнату. Натисніть, щоб повторити.',
  pl: 'Nie można wczytać tego pokoju. Dotknij, aby spróbować ponownie.',
  cs: 'Tuto místnost nelze načíst. Klepněte pro opakování.',
  sk: 'Túto miestnosť nie je možné načítať. Ťuknite pre opakovanie.',
  ro: 'Camera nu a putut fi încărcată. Atinge pentru reîncercare.',
  hu: 'Ezt a szobát nem sikerült betölteni. Koppints az újrapróbáláshoz.',
  bg: 'Стаята не може да бъде заредена. Докоснете за повторен опит.',
  hr: 'Ovu sobu nije moguće učitati. Dodirni za ponovni pokušaj.',
  sr: 'Ову собу није могуће учитати. Додирните за поново.',
  sl: 'Sobe ni mogoče naložiti. Pritisni za ponovitev.',
  nl: 'Kan deze kamer niet laden. Tik om opnieuw te proberen.',
  sv: 'Kunde inte ladda rummet. Tryck för att försöka igen.',
  da: 'Kunne ikke indlæse rummet. Tryk for at prøve igen.',
  nb: 'Kunne ikke laste rommet. Trykk for å prøve igjen.',
  fi: 'Huoneen lataus epäonnistui. Kosketa yrittääksesi uudelleen.',
  el: 'Δεν ήταν δυνατή η φόρτωση του δωματίου. Πατήστε για επανάληψη.',
  tr: 'Bu oda yüklenemedi. Yeniden denemek için dokunun.',
  ja: 'このルームを読み込めませんでした。再試行するにはタップしてください。',
  ko: '이 룸을 불러올 수 없습니다. 다시 시도하려면 탭하세요.',
  'zh-CN': '无法加载此房间。点击重试。',
  'zh-TW': '無法載入此房間。點選重試。',
  ar: 'تعذر تحميل هذه الغرفة. انقر لإعادة المحاولة.',
  he: 'לא ניתן לטעון את החדר. הקש לניסיון נוסף.',
  fa: 'بارگذاری این اتاق ممکن نشد. برای تلاش مجدد بزنید.',
  ur: 'یہ کمرہ لوڈ نہ ہو سکا۔ دوبارہ کوشش کے لیے ٹیپ کریں۔',
  hi: 'यह कमरा लोड नहीं हो सका। पुनः प्रयास के लिए टैप करें।',
  bn: 'এই কক্ষ লোড করা যায়নি। পুনরায় চেষ্টা করতে ট্যাপ করুন।',
  ta: 'இந்த அறையை ஏற்ற முடியவில்லை. மீண்டும் முயற்சிக்க தட்டவும்.',
  te: 'ఈ గదిని లోడ్ చేయలేకపోయాము. మళ్లీ ప్రయత్నించడానికి నొక్కండి.',
  mr: 'ही खोली लोड होऊ शकली नाही. पुन्हा प्रयत्न करण्यासाठी टॅप करा.',
  ml: 'ഈ മുറി ലോഡ് ചെയ്യാനായില്ല. വീണ്ടും ശ്രമിക്കാൻ ടാപ്പ് ചെയ്യുക.',
  gu: 'આ ઓરડો લોડ થઈ શક્યો નહીં. ફરી પ્રયાસ માટે ટૅપ કરો.',
  kn: 'ಈ ಕೋಣೆಯನ್ನು ಲೋಡ್ ಮಾಡಲಾಗಲಿಲ್ಲ. ಮರುಪ್ರಯತ್ನಿಸಲು ಟ್ಯಾಪ್ ಮಾಡಿ.',
  pa: 'ਇਹ ਕਮਰਾ ਲੋਡ ਨਹੀਂ ਹੋ ਸਕਿਆ। ਮੁੜ ਕੋਸ਼ਿਸ਼ ਲਈ ਟੈਪ ਕਰੋ।',
  id: 'Tidak dapat memuat ruang ini. Ketuk untuk coba lagi.',
  ms: 'Tidak dapat memuatkan bilik ini. Ketik untuk cuba lagi.',
  vi: 'Không thể tải phòng này. Chạm để thử lại.',
  th: 'ไม่สามารถโหลดห้องนี้ได้ แตะเพื่อลองอีกครั้ง.',
  fil: 'Hindi ma-load ang kuwartong ito. I-tap upang subukang muli.',
  sw: 'Imeshindwa kupakia chumba hiki. Gusa kujaribu tena.',
  af: 'Kon hierdie kamer nie laai nie. Tik om weer te probeer.',
  ca: "No s'ha pogut carregar aquesta sala. Toca per tornar-ho a provar.",
};

const STRINGS_START: LangMap = {
  en: 'Start', es: 'Empezar', fr: 'Commencer', de: 'Starten', it: 'Inizia',
  pt: 'Começar', 'pt-BR': 'Começar',
  ru: 'Начать', uk: 'Почати', pl: 'Zacznij',
  cs: 'Začít', sk: 'Začať',
  ro: 'Începe', hu: 'Indítás', bg: 'Започни',
  hr: 'Počni', sr: 'Почни', sl: 'Začni',
  nl: 'Start', sv: 'Starta', da: 'Start', nb: 'Start', fi: 'Aloita',
  el: 'Έναρξη', tr: 'Başla',
  ja: '開始', ko: '시작',
  'zh-CN': '开始', 'zh-TW': '開始',
  ar: 'ابدأ', he: 'התחל', fa: 'شروع', ur: 'شروع',
  hi: 'शुरू', bn: 'শুরু', ta: 'தொடங்கு', te: 'ప్రారంభించండి',
  mr: 'सुरू', ml: 'ആരംഭിക്കുക', gu: 'શરૂ', kn: 'ಪ್ರಾರಂಭಿಸಿ', pa: 'ਸ਼ੁਰੂ',
  id: 'Mulai', ms: 'Mula', vi: 'Bắt đầu', th: 'เริ่ม', fil: 'Simulan',
  sw: 'Anza', af: 'Begin', ca: 'Comença',
};

const STRINGS_VIEW: LangMap = {
  en: 'View', es: 'Ver', fr: 'Voir', de: 'Ansehen', it: 'Vedi',
  pt: 'Ver', 'pt-BR': 'Ver',
  ru: 'Смотреть', uk: 'Дивитись', pl: 'Zobacz',
  cs: 'Zobrazit', sk: 'Zobraziť',
  ro: 'Vezi', hu: 'Megnéz', bg: 'Виж',
  hr: 'Pogledaj', sr: 'Погледај', sl: 'Poglej',
  nl: 'Bekijken', sv: 'Visa', da: 'Vis', nb: 'Vis', fi: 'Katso',
  el: 'Προβολή', tr: 'Görüntüle',
  ja: '見る', ko: '보기',
  'zh-CN': '查看', 'zh-TW': '檢視',
  ar: 'عرض', he: 'הצג', fa: 'مشاهده', ur: 'دیکھیں',
  hi: 'देखें', bn: 'দেখুন', ta: 'பார்', te: 'చూడండి',
  mr: 'पाहा', ml: 'കാണുക', gu: 'જુઓ', kn: 'ನೋಡಿ', pa: 'ਦੇਖੋ',
  id: 'Lihat', ms: 'Lihat', vi: 'Xem', th: 'ดู', fil: 'Tingnan',
  sw: 'Tazama', af: 'Bekyk', ca: 'Mira',
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

const STRINGS_BACK_TO_ROOM: LangMap = {
  en: 'Back to room', es: 'Volver a la sala', fr: 'Retour à la salle',
  de: 'Zurück zum Raum', it: 'Torna alla stanza',
  pt: 'Voltar à sala', 'pt-BR': 'Voltar à sala',
  ru: 'Назад в зал', uk: 'Назад до кімнати',
  pl: 'Wróć do pokoju', cs: 'Zpět do místnosti', sk: 'Späť do miestnosti',
  ro: 'Înapoi la cameră', hu: 'Vissza a szobához', bg: 'Назад към стаята',
  hr: 'Natrag u sobu', sr: 'Назад у собу', sl: 'Nazaj v sobo',
  nl: 'Terug naar kamer', sv: 'Tillbaka till rum', da: 'Tilbage til rum',
  nb: 'Tilbake til rom', fi: 'Takaisin huoneeseen',
  el: 'Πίσω στο δωμάτιο', tr: 'Odaya dön',
  ja: 'ルームに戻る', ko: '룸으로 돌아가기',
  'zh-CN': '返回房间', 'zh-TW': '返回房間',
  ar: 'العودة إلى الغرفة', he: 'חזרה לחדר',
  fa: 'بازگشت به اتاق', ur: 'کمرے میں واپس',
  hi: 'कमरे में वापस', bn: 'কক্ষে ফিরে যান', ta: 'அறைக்குத் திரும்பு',
  te: 'గదికి తిరిగి వెళ్లు', mr: 'खोलीत परत जा',
  ml: 'മുറിയിലേക്ക് മടങ്ങുക', gu: 'ઓરડામાં પાછા જાઓ',
  kn: 'ಕೋಣೆಗೆ ಹಿಂತಿರುಗಿ', pa: 'ਕਮਰੇ ਤੇ ਵਾਪਸ',
  id: 'Kembali ke ruang', ms: 'Kembali ke bilik',
  vi: 'Quay lại phòng', th: 'กลับไปที่ห้อง', fil: 'Bumalik sa kuwarto',
  sw: 'Rudi chumbani', af: 'Terug na kamer', ca: 'Torna a la sala',
};

const STRINGS_BACK_TO_ROOMS: LangMap = {
  en: 'Back to rooms', es: 'Volver a las salas', fr: 'Retour aux salles',
  de: 'Zurück zu den Räumen', it: 'Torna alle stanze',
  pt: 'Voltar às salas', 'pt-BR': 'Voltar às salas',
  ru: 'Назад к залам', uk: 'Назад до кімнат',
  pl: 'Wróć do pokojów', cs: 'Zpět k místnostem', sk: 'Späť k miestnostiam',
  ro: 'Înapoi la camere', hu: 'Vissza a szobákhoz', bg: 'Назад към стаите',
  hr: 'Natrag na sobe', sr: 'Назад на собе', sl: 'Nazaj na sobe',
  nl: 'Terug naar kamers', sv: 'Tillbaka till rum', da: 'Tilbage til rum',
  nb: 'Tilbake til rom', fi: 'Takaisin huoneisiin',
  el: 'Πίσω στα δωμάτια', tr: 'Odalara dön',
  ja: 'ルーム選択に戻る', ko: '룸 목록으로 돌아가기',
  'zh-CN': '返回房间列表', 'zh-TW': '返回房間列表',
  ar: 'العودة إلى الغرف', he: 'חזרה לחדרים',
  fa: 'بازگشت به اتاق‌ها', ur: 'کمروں میں واپس',
  hi: 'कमरों में वापस', bn: 'কক্ষগুলিতে ফিরে যান',
  ta: 'அறைகளுக்குத் திரும்பு', te: 'గదులకు తిరిగి వెళ్లు',
  mr: 'खोल्यांकडे परत जा', ml: 'മുറികളിലേക്ക് മടങ്ങുക',
  gu: 'ઓરડાઓમાં પાછા જાઓ', kn: 'ಕೋಣೆಗಳಿಗೆ ಹಿಂತಿರುಗಿ',
  pa: 'ਕਮਰਿਆਂ ਤੇ ਵਾਪਸ',
  id: 'Kembali ke ruang', ms: 'Kembali ke bilik',
  vi: 'Quay lại các phòng', th: 'กลับไปที่ห้องต่างๆ',
  fil: 'Bumalik sa mga kuwarto',
  sw: 'Rudi vyumbani', af: 'Terug na kamers', ca: 'Torna a les sales',
};

const STRINGS_ZOOM_IN: LangMap = {
  en: 'Zoom in', es: 'Acercar', fr: 'Zoom avant', de: 'Vergrößern',
  it: 'Ingrandisci', pt: 'Aumentar', 'pt-BR': 'Aumentar zoom',
  ru: 'Увеличить', uk: 'Збільшити', pl: 'Powiększ',
  cs: 'Přiblížit', sk: 'Priblížiť',
  ro: 'Mărește', hu: 'Nagyítás', bg: 'Увеличи',
  hr: 'Povećaj', sr: 'Увећај', sl: 'Povečaj',
  nl: 'Inzoomen', sv: 'Zooma in', da: 'Zoom ind', nb: 'Zoom inn', fi: 'Lähennä',
  el: 'Μεγέθυνση', tr: 'Yakınlaştır',
  ja: '拡大', ko: '확대',
  'zh-CN': '放大', 'zh-TW': '放大',
  ar: 'تكبير', he: 'התקרב', fa: 'بزرگ‌نمایی', ur: 'زوم اِن',
  hi: 'ज़ूम इन', bn: 'জুম ইন', ta: 'பெரிதாக்கு', te: 'జూమ్ ఇన్',
  mr: 'मोठे करा', ml: 'വലുതാക്കുക', gu: 'ઝૂમ ઇન',
  kn: 'ಜೂಮ್ ಇನ್', pa: 'ਜ਼ੂਮ ਇਨ',
  id: 'Perbesar', ms: 'Zum masuk', vi: 'Phóng to', th: 'ซูมเข้า', fil: 'Mag-zoom in',
  sw: 'Vuta karibu', af: 'Vergroot', ca: 'Amplia',
};

const STRINGS_ZOOM_OUT: LangMap = {
  en: 'Zoom out', es: 'Alejar', fr: 'Zoom arrière', de: 'Verkleinern',
  it: 'Rimpicciolisci', pt: 'Diminuir', 'pt-BR': 'Diminuir zoom',
  ru: 'Уменьшить', uk: 'Зменшити', pl: 'Pomniejsz',
  cs: 'Oddálit', sk: 'Oddialiť',
  ro: 'Micșorează', hu: 'Kicsinyítés', bg: 'Намали',
  hr: 'Smanji', sr: 'Умањи', sl: 'Pomanjšaj',
  nl: 'Uitzoomen', sv: 'Zooma ut', da: 'Zoom ud', nb: 'Zoom ut', fi: 'Loitonna',
  el: 'Σμίκρυνση', tr: 'Uzaklaştır',
  ja: '縮小', ko: '축소',
  'zh-CN': '缩小', 'zh-TW': '縮小',
  ar: 'تصغير', he: 'התרחק', fa: 'کوچک‌نمایی', ur: 'زوم آؤٹ',
  hi: 'ज़ूम आउट', bn: 'জুম আউট', ta: 'சிறிதாக்கு', te: 'జూమ్ అవుట్',
  mr: 'छोटे करा', ml: 'ചെറുതാക്കുക', gu: 'ઝૂમ આઉટ',
  kn: 'ಜೂಮ್ ಔಟ್', pa: 'ਜ਼ੂਮ ਆਊਟ',
  id: 'Perkecil', ms: 'Zum keluar', vi: 'Thu nhỏ', th: 'ซูมออก', fil: 'Mag-zoom out',
  sw: 'Vuta mbali', af: 'Verklein', ca: 'Redueix',
};

const STRINGS_COLOUR_PALETTE: LangMap = {
  en: 'Colour palette', es: 'Paleta de colores', fr: 'Palette de couleurs',
  de: 'Farbpalette', it: 'Tavolozza colori',
  pt: 'Paleta de cores', 'pt-BR': 'Paleta de cores',
  ru: 'Палитра цветов', uk: 'Палітра кольорів',
  pl: 'Paleta kolorów', cs: 'Paleta barev', sk: 'Paleta farieb',
  ro: 'Paletă de culori', hu: 'Színpaletta', bg: 'Цветова палитра',
  hr: 'Paleta boja', sr: 'Палета боја', sl: 'Barvna paleta',
  nl: 'Kleurenpalet', sv: 'Färgpalett', da: 'Farvepalette',
  nb: 'Fargepalett', fi: 'Väripaletti',
  el: 'Παλέτα χρωμάτων', tr: 'Renk paleti',
  ja: 'カラーパレット', ko: '색상 팔레트',
  'zh-CN': '调色板', 'zh-TW': '調色盤',
  ar: 'لوحة الألوان', he: 'לוח צבעים',
  fa: 'پالت رنگ', ur: 'رنگوں کا پیلٹ',
  hi: 'रंग पैलेट', bn: 'রঙের প্যালেট',
  ta: 'வண்ணத் தட்டு', te: 'రంగుల ప్యాలెట్',
  mr: 'रंग पॅलेट', ml: 'വർണ്ണ പാലറ്റ്',
  gu: 'રંગ પૅલેટ', kn: 'ಬಣ್ಣದ ಪ್ಯಾಲೆಟ್',
  pa: 'ਰੰਗ ਪੈਲੇਟ',
  id: 'Palet warna', ms: 'Palet warna',
  vi: 'Bảng màu', th: 'จานสี', fil: 'Palette ng kulay',
  sw: 'Paleti ya rangi', af: 'Kleurpalet', ca: 'Paleta de colors',
};

const STRINGS_MINIMAP: LangMap = {
  en: 'Minimap', es: 'Minimapa', fr: 'Mini-carte', de: 'Übersichtskarte',
  it: 'Minimappa', pt: 'Mini-mapa', 'pt-BR': 'Mini-mapa',
  ru: 'Мини-карта', uk: 'Міні-карта',
  pl: 'Mini-mapa', cs: 'Mini-mapa', sk: 'Mini-mapa',
  ro: 'Mini-hartă', hu: 'Mini térkép', bg: 'Мини карта',
  hr: 'Mini-karta', sr: 'Мини-карта', sl: 'Mini zemljevid',
  nl: 'Minikaart', sv: 'Minikarta', da: 'Minikort', nb: 'Minikart',
  fi: 'Pienoiskartta',
  el: 'Μικρός χάρτης', tr: 'Mini harita',
  ja: 'ミニマップ', ko: '미니맵',
  'zh-CN': '小地图', 'zh-TW': '小地圖',
  ar: 'خريطة مصغرة', he: 'מיני-מפה',
  fa: 'نقشه کوچک', ur: 'چھوٹا نقشہ',
  hi: 'मिनी मानचित्र', bn: 'মিনি ম্যাপ',
  ta: 'சிறு வரைபடம்', te: 'మినీ మ్యాప్',
  mr: 'मिनी नकाशा', ml: 'മിനി മാപ്പ്',
  gu: 'મિની નકશો', kn: 'ಮಿನಿ ನಕ್ಷೆ',
  pa: 'ਮਿਨੀ ਨਕਸ਼ਾ',
  id: 'Peta mini', ms: 'Peta mini',
  vi: 'Bản đồ nhỏ', th: 'แผนที่ย่อ', fil: 'Minimapa',
  sw: 'Ramani ndogo', af: 'Mini-kaart', ca: 'Mini-mapa',
};

const STRINGS_COLOUR_LABEL: LangMap = {
  en: 'Colour {n}', es: 'Color {n}', fr: 'Couleur {n}', de: 'Farbe {n}',
  it: 'Colore {n}', pt: 'Cor {n}', 'pt-BR': 'Cor {n}',
  ru: 'Цвет {n}', uk: 'Колір {n}',
  pl: 'Kolor {n}', cs: 'Barva {n}', sk: 'Farba {n}',
  ro: 'Culoarea {n}', hu: 'Szín {n}', bg: 'Цвят {n}',
  hr: 'Boja {n}', sr: 'Боја {n}', sl: 'Barva {n}',
  nl: 'Kleur {n}', sv: 'Färg {n}', da: 'Farve {n}', nb: 'Farge {n}', fi: 'Väri {n}',
  el: 'Χρώμα {n}', tr: 'Renk {n}',
  ja: '色 {n}', ko: '색상 {n}',
  'zh-CN': '颜色 {n}', 'zh-TW': '顏色 {n}',
  ar: 'اللون {n}', he: 'צבע {n}', fa: 'رنگ {n}', ur: 'رنگ {n}',
  hi: 'रंग {n}', bn: 'রঙ {n}', ta: 'நிறம் {n}', te: 'రంగు {n}',
  mr: 'रंग {n}', ml: 'നിറം {n}', gu: 'રંગ {n}',
  kn: 'ಬಣ್ಣ {n}', pa: 'ਰੰਗ {n}',
  id: 'Warna {n}', ms: 'Warna {n}', vi: 'Màu {n}', th: 'สี {n}', fil: 'Kulay {n}',
  sw: 'Rangi {n}', af: 'Kleur {n}', ca: 'Color {n}',
};

const STRINGS_PIC_STATE_COMPLETED: LangMap = {
  en: 'completed', es: 'completado', fr: 'terminé', de: 'abgeschlossen',
  it: 'completato', pt: 'concluído', 'pt-BR': 'concluído',
  ru: 'завершено', uk: 'завершено',
  pl: 'ukończono', cs: 'dokončeno', sk: 'dokončené',
  ro: 'finalizat', hu: 'kész', bg: 'завършено',
  hr: 'dovršeno', sr: 'завршено', sl: 'dokončano',
  nl: 'voltooid', sv: 'klar', da: 'færdig', nb: 'ferdig', fi: 'valmis',
  el: 'ολοκληρώθηκε', tr: 'tamamlandı',
  ja: '完了', ko: '완료',
  'zh-CN': '已完成', 'zh-TW': '已完成',
  ar: 'مكتمل', he: 'הושלם', fa: 'تکمیل شده', ur: 'مکمل',
  hi: 'पूर्ण', bn: 'সম্পন্ন', ta: 'முடிந்தது', te: 'పూర్తయింది',
  mr: 'पूर्ण', ml: 'പൂർത്തിയായി', gu: 'પૂર્ણ',
  kn: 'ಪೂರ್ಣಗೊಂಡಿದೆ', pa: 'ਮੁਕੰਮਲ',
  id: 'selesai', ms: 'selesai', vi: 'hoàn thành', th: 'เสร็จสิ้น', fil: 'tapos na',
  sw: 'imekamilika', af: 'voltooi', ca: 'completat',
};

const STRINGS_PIC_STATE_IN_PROGRESS: LangMap = {
  en: 'in progress', es: 'en progreso', fr: 'en cours', de: 'in Bearbeitung',
  it: 'in corso', pt: 'em andamento', 'pt-BR': 'em andamento',
  ru: 'в процессе', uk: 'у процесі',
  pl: 'w toku', cs: 'probíhá', sk: 'prebieha',
  ro: 'în desfășurare', hu: 'folyamatban', bg: 'в ход',
  hr: 'u tijeku', sr: 'у току', sl: 'v teku',
  nl: 'bezig', sv: 'pågår', da: 'i gang', nb: 'i gang', fi: 'kesken',
  el: 'σε εξέλιξη', tr: 'devam ediyor',
  ja: '進行中', ko: '진행 중',
  'zh-CN': '进行中', 'zh-TW': '進行中',
  ar: 'قيد التقدم', he: 'בתהליך', fa: 'در حال انجام', ur: 'جاری',
  hi: 'चालू', bn: 'চলমান', ta: 'செயலில்', te: 'ప్రోగతిలో',
  mr: 'चालू', ml: 'പുരോഗതിയിൽ', gu: 'ચાલુ',
  kn: 'ಪ್ರಗತಿಯಲ್ಲಿದೆ', pa: 'ਜਾਰੀ',
  id: 'berlangsung', ms: 'sedang dilakukan',
  vi: 'đang thực hiện', th: 'กำลังดำเนินการ', fil: 'ginagawa',
  sw: 'inaendelea', af: 'aan die gang', ca: 'en curs',
};

const STRINGS_PIC_STATE_NOT_STARTED: LangMap = {
  en: 'not started', es: 'sin comenzar', fr: 'non commencé', de: 'nicht gestartet',
  it: 'non iniziato', pt: 'não iniciado', 'pt-BR': 'não iniciado',
  ru: 'не начато', uk: 'не розпочато',
  pl: 'nie rozpoczęto', cs: 'nezahájeno', sk: 'nezačaté',
  ro: 'neînceput', hu: 'nem indult', bg: 'не е започнато',
  hr: 'nije započeto', sr: 'није започето', sl: 'ni začeto',
  nl: 'niet gestart', sv: 'ej påbörjad', da: 'ikke startet',
  nb: 'ikke startet', fi: 'aloittamatta',
  el: 'δεν ξεκίνησε', tr: 'başlanmadı',
  ja: '未開始', ko: '시작 안 함',
  'zh-CN': '未开始', 'zh-TW': '未開始',
  ar: 'لم يبدأ', he: 'לא התחיל', fa: 'شروع نشده', ur: 'شروع نہیں ہوا',
  hi: 'शुरू नहीं', bn: 'শুরু হয়নি', ta: 'தொடங்கவில்லை',
  te: 'ప్రారంభం కాలేదు', mr: 'सुरू नाही',
  ml: 'ആരംഭിച്ചിട്ടില്ല', gu: 'શરૂ નથી થયું',
  kn: 'ಪ್ರಾರಂಭವಾಗಿಲ್ಲ', pa: 'ਸ਼ੁਰੂ ਨਹੀਂ ਹੋਇਆ',
  id: 'belum dimulai', ms: 'belum dimulakan',
  vi: 'chưa bắt đầu', th: 'ยังไม่เริ่ม', fil: 'hindi pa nasimulan',
  sw: 'haijaanza', af: 'nie begin nie', ca: 'no iniciat',
};

const STRINGS_PIC_STATE_LOADING: LangMap = {
  en: 'loading', es: 'cargando', fr: 'chargement', de: 'lädt',
  it: 'caricamento', pt: 'a carregar', 'pt-BR': 'carregando',
  ru: 'загрузка', uk: 'завантаження',
  pl: 'ładowanie', cs: 'načítání', sk: 'načítava sa',
  ro: 'se încarcă', hu: 'betöltés', bg: 'зареждане',
  hr: 'učitavanje', sr: 'учитавање', sl: 'nalaganje',
  nl: 'laden', sv: 'laddar', da: 'indlæser', nb: 'laster', fi: 'lataa',
  el: 'φόρτωση', tr: 'yükleniyor',
  ja: '読み込み中', ko: '로딩 중',
  'zh-CN': '加载中', 'zh-TW': '載入中',
  ar: 'جارٍ التحميل', he: 'טוען',
  fa: 'در حال بارگذاری', ur: 'لوڈ ہو رہا',
  hi: 'लोड हो रहा', bn: 'লোড হচ্ছে',
  ta: 'ஏற்றப்படுகிறது', te: 'లోడ్ అవుతోంది',
  mr: 'लोड होत आहे', ml: 'ലോഡ് ചെയ്യുന്നു',
  gu: 'લોડ થઈ રહ્યું', kn: 'ಲೋಡ್ ಆಗುತ್ತಿದೆ',
  pa: 'ਲੋਡ ਹੋ ਰਿਹਾ',
  id: 'memuat', ms: 'memuatkan', vi: 'đang tải', th: 'กำลังโหลด', fil: 'naglo-load',
  sw: 'inapakia', af: 'laai', ca: 'carregant',
};

const STRINGS_PIC_STATE_FAILED: LangMap = {
  en: 'failed — tap to retry',
  es: 'error — toca para reintentar',
  fr: 'échec — touchez pour réessayer',
  de: 'fehlgeschlagen — tippen zum Wiederholen',
  it: 'errore — tocca per riprovare',
  pt: 'falhou — toque para tentar de novo',
  'pt-BR': 'falhou — toque para tentar novamente',
  ru: 'ошибка — нажмите, чтобы повторить',
  uk: 'помилка — натисніть, щоб повторити',
  pl: 'błąd — dotknij, aby spróbować ponownie',
  cs: 'selhalo — klepněte pro opakování',
  sk: 'zlyhalo — ťuknite pre opakovanie',
  ro: 'eșuat — atinge pentru reîncercare',
  hu: 'hiba — koppints az újrapróbáláshoz',
  bg: 'грешка — докоснете за повторен опит',
  hr: 'neuspjelo — dodirni za pokušaj',
  sr: 'неуспело — додирните за поново',
  sl: 'neuspešno — pritisni za ponovitev',
  nl: 'mislukt — tik om opnieuw te proberen',
  sv: 'misslyckades — tryck för att försöka igen',
  da: 'mislykkedes — tryk for at prøve igen',
  nb: 'mislyktes — trykk for å prøve igjen',
  fi: 'epäonnistui — kosketa yrittääksesi uudelleen',
  el: 'απέτυχε — πατήστε για επανάληψη',
  tr: 'başarısız — yeniden denemek için dokunun',
  ja: '失敗 — タップで再試行',
  ko: '실패 — 다시 시도하려면 탭',
  'zh-CN': '失败 — 点击重试',
  'zh-TW': '失敗 — 點選重試',
  ar: 'فشل — انقر للمحاولة مرة أخرى',
  he: 'נכשל — הקש לניסיון נוסף',
  fa: 'ناموفق — برای تلاش مجدد بزنید',
  ur: 'ناکام — دوبارہ کوشش کے لیے ٹیپ کریں',
  hi: 'विफल — पुनः प्रयास के लिए टैप करें',
  bn: 'ব্যর্থ — পুনরায় চেষ্টা করতে ট্যাপ করুন',
  ta: 'தோல்வி — மீண்டும் முயற்சிக்க தட்டவும்',
  te: 'విఫలమైంది — మళ్లీ ప్రయత్నించడానికి నొక్కండి',
  mr: 'अयशस्वी — पुन्हा प्रयत्न करण्यासाठी टॅप करा',
  ml: 'പരാജയപ്പെട്ടു — വീണ്ടും ശ്രമിക്കാൻ ടാപ്പ് ചെയ്യുക',
  gu: 'નિષ્ફળ — ફરી પ્રયાસ માટે ટૅપ કરો',
  kn: 'ವಿಫಲವಾಗಿದೆ — ಮರುಪ್ರಯತ್ನಿಸಲು ಟ್ಯಾಪ್ ಮಾಡಿ',
  pa: 'ਅਸਫਲ — ਮੁੜ ਕੋਸ਼ਿਸ਼ ਲਈ ਟੈਪ ਕਰੋ',
  id: 'gagal — ketuk untuk coba lagi',
  ms: 'gagal — ketik untuk cuba lagi',
  vi: 'thất bại — chạm để thử lại',
  th: 'ล้มเหลว — แตะเพื่อลองอีกครั้ง',
  fil: 'nabigo — i-tap upang subukang muli',
  sw: 'imeshindwa — gusa kujaribu tena',
  af: 'misluk — tik om weer te probeer',
  ca: 'error — toca per tornar-ho a provar',
};

const STRINGS_ROOM_CELL_LABEL: LangMap = {
  en: 'Room {n}, {done} of {total} complete ({pct}%)',
  es: 'Sala {n}, {done} de {total} completadas ({pct}%)',
  fr: 'Salle {n}, {done} sur {total} terminées ({pct}%)',
  de: 'Raum {n}, {done} von {total} fertig ({pct}%)',
  it: 'Stanza {n}, {done} di {total} completate ({pct}%)',
  pt: 'Sala {n}, {done} de {total} concluídas ({pct}%)',
  'pt-BR': 'Sala {n}, {done} de {total} concluídas ({pct}%)',
  ru: 'Зал {n}, {done} из {total} завершено ({pct}%)',
  uk: 'Кімната {n}, {done} з {total} завершено ({pct}%)',
  pl: 'Pokój {n}, {done} z {total} ukończonych ({pct}%)',
  cs: 'Místnost {n}, {done} z {total} dokončeno ({pct}%)',
  sk: 'Miestnosť {n}, {done} z {total} dokončené ({pct}%)',
  ro: 'Camera {n}, {done} din {total} finalizate ({pct}%)',
  hu: '{n}. szoba, {done}/{total} kész ({pct}%)',
  bg: 'Стая {n}, {done} от {total} завършени ({pct}%)',
  hr: 'Soba {n}, {done} od {total} dovršeno ({pct}%)',
  sr: 'Соба {n}, {done} од {total} завршено ({pct}%)',
  sl: 'Soba {n}, {done} od {total} dokončano ({pct}%)',
  nl: 'Kamer {n}, {done} van {total} voltooid ({pct}%)',
  sv: 'Rum {n}, {done} av {total} klara ({pct}%)',
  da: 'Rum {n}, {done} af {total} færdig ({pct}%)',
  nb: 'Rom {n}, {done} av {total} ferdig ({pct}%)',
  fi: 'Huone {n}, {done}/{total} valmis ({pct}%)',
  el: 'Δωμάτιο {n}, {done} από {total} ολοκληρωμένα ({pct}%)',
  tr: 'Oda {n}, {done}/{total} tamamlandı (%{pct})',
  ja: 'ルーム {n}、{total} 中 {done} 完了 ({pct}%)',
  ko: '룸 {n}, {total} 중 {done} 완료 ({pct}%)',
  'zh-CN': '房间 {n}，{total} 中 {done} 完成 ({pct}%)',
  'zh-TW': '房間 {n}，{total} 中 {done} 完成 ({pct}%)',
  ar: 'غرفة {n}، {done} من {total} مكتملة ({pct}%)',
  he: 'חדר {n}, {done} מתוך {total} הושלמו ({pct}%)',
  fa: 'اتاق {n}، {done} از {total} تکمیل شده ({pct}%)',
  ur: 'کمرہ {n}، {total} میں سے {done} مکمل ({pct}%)',
  hi: 'कमरा {n}, {total} में से {done} पूर्ण ({pct}%)',
  bn: 'কক্ষ {n}, {total} এর মধ্যে {done} সম্পন্ন ({pct}%)',
  ta: 'அறை {n}, {total} இல் {done} முடிந்தது ({pct}%)',
  te: 'గది {n}, {total} లో {done} పూర్తయింది ({pct}%)',
  mr: 'खोली {n}, {total} पैकी {done} पूर्ण ({pct}%)',
  ml: 'മുറി {n}, {total} ൽ {done} പൂർത്തിയായി ({pct}%)',
  gu: 'ઓરડો {n}, {total} માંથી {done} પૂર્ણ ({pct}%)',
  kn: 'ಕೋಣೆ {n}, {total} ರಲ್ಲಿ {done} ಪೂರ್ಣ ({pct}%)',
  pa: 'ਕਮਰਾ {n}, {total} ਵਿੱਚੋਂ {done} ਮੁਕੰਮਲ ({pct}%)',
  id: 'Ruang {n}, {done} dari {total} selesai ({pct}%)',
  ms: 'Bilik {n}, {done} daripada {total} selesai ({pct}%)',
  vi: 'Phòng {n}, {done}/{total} hoàn thành ({pct}%)',
  th: 'ห้อง {n}, {done}/{total} เสร็จ ({pct}%)',
  fil: 'Kuwarto {n}, {done} sa {total} tapos na ({pct}%)',
  sw: 'Chumba {n}, {done} kati ya {total} kamili ({pct}%)',
  af: 'Kamer {n}, {done} van {total} voltooi ({pct}%)',
  ca: 'Sala {n}, {done} de {total} completades ({pct}%)',
};

const STRINGS_ROOM_CELL_LOCKED: LangMap = {
  en: 'Room {n} locked. Complete {n} pictures in room {prev} to unlock.',
  es: 'Sala {n} bloqueada. Completa {n} imágenes en la sala {prev} para desbloquear.',
  fr: 'Salle {n} verrouillée. Termine {n} images dans la salle {prev} pour déverrouiller.',
  de: 'Raum {n} gesperrt. Schließe {n} Bilder in Raum {prev} ab, um freizuschalten.',
  it: 'Stanza {n} bloccata. Completa {n} immagini nella stanza {prev} per sbloccare.',
  pt: 'Sala {n} bloqueada. Conclui {n} imagens na sala {prev} para desbloquear.',
  'pt-BR': 'Sala {n} bloqueada. Conclua {n} imagens na sala {prev} para desbloquear.',
  ru: 'Зал {n} закрыт. Завершите {n} изображений в зале {prev}, чтобы открыть.',
  uk: 'Кімната {n} закрита. Завершіть {n} зображень у кімнаті {prev}, щоб відкрити.',
  pl: 'Pokój {n} zablokowany. Ukończ {n} obrazów w pokoju {prev}, aby odblokować.',
  cs: 'Místnost {n} uzamčena. Dokončete {n} obrázků v místnosti {prev} pro odemčení.',
  sk: 'Miestnosť {n} uzamknutá. Dokončite {n} obrázkov v miestnosti {prev} pre odomknutie.',
  ro: 'Camera {n} blocată. Finalizează {n} imagini în camera {prev} pentru a debloca.',
  hu: '{n}. szoba zárolva. Fejezz be {n} képet a(z) {prev}. szobában a feloldáshoz.',
  bg: 'Стая {n} заключена. Завършете {n} изображения в стая {prev}, за да отключите.',
  hr: 'Soba {n} zaključana. Dovrši {n} slika u sobi {prev} za otključavanje.',
  sr: 'Соба {n} закључана. Завршите {n} слика у соби {prev} за откључавање.',
  sl: 'Soba {n} zaklenjena. Dokončaj {n} slik v sobi {prev} za odklep.',
  nl: 'Kamer {n} vergrendeld. Voltooi {n} afbeeldingen in kamer {prev} om te ontgrendelen.',
  sv: 'Rum {n} låst. Slutför {n} bilder i rum {prev} för att låsa upp.',
  da: 'Rum {n} låst. Fuldfør {n} billeder i rum {prev} for at låse op.',
  nb: 'Rom {n} låst. Fullfør {n} bilder i rom {prev} for å låse opp.',
  fi: 'Huone {n} lukittu. Suorita {n} kuvaa huoneessa {prev} avataksesi.',
  el: 'Δωμάτιο {n} κλειδωμένο. Ολοκλήρωσε {n} εικόνες στο δωμάτιο {prev} για ξεκλείδωμα.',
  tr: 'Oda {n} kilitli. Açmak için oda {prev}\'da {n} resim tamamla.',
  ja: 'ルーム {n} はロック中。ルーム {prev} で {n} 枚完成させると解放。',
  ko: '룸 {n} 잠김. 룸 {prev}에서 {n}개 그림을 완성하면 해제됩니다.',
  'zh-CN': '房间 {n} 已锁定。完成房间 {prev} 中的 {n} 张图片以解锁。',
  'zh-TW': '房間 {n} 已鎖定。完成房間 {prev} 中的 {n} 張圖片以解鎖。',
  ar: 'الغرفة {n} مقفلة. أكمل {n} صور في الغرفة {prev} للفتح.',
  he: 'חדר {n} נעול. השלם {n} תמונות בחדר {prev} כדי לפתוח.',
  fa: 'اتاق {n} قفل است. برای باز کردن، {n} تصویر در اتاق {prev} را تکمیل کنید.',
  ur: 'کمرہ {n} مقفل ہے۔ کھولنے کے لیے کمرہ {prev} میں {n} تصاویر مکمل کریں۔',
  hi: 'कमरा {n} बंद। खोलने के लिए कमरा {prev} में {n} चित्र पूरे करें।',
  bn: 'কক্ষ {n} লক। আনলক করতে কক্ষ {prev}-এ {n}টি ছবি সম্পন্ন করুন।',
  ta: 'அறை {n} பூட்டியது. திறக்க அறை {prev} இல் {n} படங்களை முடிக்கவும்.',
  te: 'గది {n} లాక్ చేయబడింది. అన్‌లాక్ చేయడానికి గది {prev} లో {n} చిత్రాలను పూర్తి చేయండి.',
  mr: 'खोली {n} बंद. अनलॉक करण्यासाठी खोली {prev} मध्ये {n} चित्रे पूर्ण करा.',
  ml: 'മുറി {n} ലോക്കാണ്. അൺലോക്ക് ചെയ്യാൻ മുറി {prev} ൽ {n} ചിത്രങ്ങൾ പൂർത്തിയാക്കുക.',
  gu: 'ઓરડો {n} લૉક. અનલૉક માટે ઓરડા {prev} માં {n} ચિત્રો પૂર્ણ કરો.',
  kn: 'ಕೋಣೆ {n} ಲಾಕ್ ಆಗಿದೆ. ಅನ್‌ಲಾಕ್ ಮಾಡಲು ಕೋಣೆ {prev} ರಲ್ಲಿ {n} ಚಿತ್ರಗಳನ್ನು ಪೂರ್ಣಗೊಳಿಸಿ.',
  pa: 'ਕਮਰਾ {n} ਲੌਕ ਹੈ। ਅਨਲੌਕ ਲਈ ਕਮਰਾ {prev} ਵਿੱਚ {n} ਚਿੱਤਰ ਮੁਕੰਮਲ ਕਰੋ।',
  id: 'Ruang {n} terkunci. Selesaikan {n} gambar di ruang {prev} untuk membuka.',
  ms: 'Bilik {n} dikunci. Selesaikan {n} gambar dalam bilik {prev} untuk membuka.',
  vi: 'Phòng {n} đã khóa. Hoàn thành {n} hình ảnh trong phòng {prev} để mở khóa.',
  th: 'ห้อง {n} ถูกล็อก เสร็จ {n} ภาพในห้อง {prev} เพื่อปลดล็อก',
  fil: 'Naka-lock ang kuwarto {n}. Tapusin ang {n} larawan sa kuwarto {prev} para i-unlock.',
  sw: 'Chumba {n} kimefungwa. Maliza picha {n} katika chumba {prev} kufungua.',
  af: 'Kamer {n} gesluit. Voltooi {n} prente in kamer {prev} om oop te sluit.',
  ca: 'Sala {n} bloquejada. Completa {n} imatges a la sala {prev} per desbloquejar.',
};

// One lookup table to make iteration easy.
type StringKey =
  | 'room' | 'chooseRoom' | 'loadingPictures' | 'loadingPuzzle'
  | 'noPicturesYet' | 'couldNotLoadThumbs' | 'couldNotLoadPuzzle' | 'retry'
  | 'hint' | 'hinted' | 'hintUnlocked'
  | 'done' | 'completeTitle' | 'doneBadge'
  | 'roomLoadFailed'
  | 'start' | 'view'
  | 'backToRoom' | 'backToRooms'
  | 'zoomIn' | 'zoomOut'
  | 'colourPalette' | 'minimap' | 'colourLabel'
  | 'picStateCompleted' | 'picStateInProgress' | 'picStateNotStarted'
  | 'picStateLoading' | 'picStateFailed'
  | 'roomCellLabel' | 'roomCellLocked';

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
  hintUnlocked: STRINGS_HINT_UNLOCKED,
  done: STRINGS_DONE,
  completeTitle: STRINGS_COMPLETE_TITLE,
  doneBadge: STRINGS_DONE_BADGE,
  roomLoadFailed: STRINGS_ROOM_LOAD_FAILED,
  start: STRINGS_START,
  view: STRINGS_VIEW,
  backToRoom: STRINGS_BACK_TO_ROOM,
  backToRooms: STRINGS_BACK_TO_ROOMS,
  zoomIn: STRINGS_ZOOM_IN,
  zoomOut: STRINGS_ZOOM_OUT,
  colourPalette: STRINGS_COLOUR_PALETTE,
  minimap: STRINGS_MINIMAP,
  colourLabel: STRINGS_COLOUR_LABEL,
  picStateCompleted: STRINGS_PIC_STATE_COMPLETED,
  picStateInProgress: STRINGS_PIC_STATE_IN_PROGRESS,
  picStateNotStarted: STRINGS_PIC_STATE_NOT_STARTED,
  picStateLoading: STRINGS_PIC_STATE_LOADING,
  picStateFailed: STRINGS_PIC_STATE_FAILED,
  roomCellLabel: STRINGS_ROOM_CELL_LABEL,
  roomCellLocked: STRINGS_ROOM_CELL_LOCKED,
};

export const lang: Lang = detectLang();

// html lang/dir setup. Runs at module import so it's done before any
// UI string is rendered.
{
  const rtl = RTL_LANGS.has(lang);
  if (document.documentElement) {
    document.documentElement.setAttribute('lang', lang);
    document.documentElement.setAttribute('dir', rtl ? 'rtl' : 'ltr');
  }
}

export function t(key: StringKey, params?: Record<string, string | number>): string {
  const entry = TABLE[key];
  const base = entry[lang] ?? entry.en ?? key;
  if (!params) return base;
  return base.replace(/\{(\w+)\}/g, (_, name) =>
    params[name] !== undefined ? String(params[name]) : `{${name}}`,
  );
}
