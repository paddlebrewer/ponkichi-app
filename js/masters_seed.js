// ============================================================
// masters_seed.js — 原料マスターの暫定同梱データ（フォールバック用）
// ============================================================
// ⚠ このファイルはPonkichiの「写し（キャッシュ）」であって正本ではない。
// 出典：本番Ponkichi「原料マスター」シート／取得日：2026-07-31（doGet action=read）／47件。
// 分類も実データの「原料分類」列をそのまま使う（推定しない）。原料マスターは5分類だが
// 入荷ペイロードは4区分（麦芽/ホップ/酵母/入荷した原料）なので、麦・米・糖類 と その他 は
// どちらも「その他の原料」に寄せる。この対応は masters.js の normalizeCategory と揃えること。
// ライブのPonkichi「原料マスター」を doGet action=read で取得できた場合は必ずそちらを優先し、
// このファイルは通信不可時のフォールバックとしてのみ使う。
// 更新するときは手で足さず、Ponkichiから取り直して丸ごと差し替える（手足しは幽霊マスターの原因）。
// 【前版の実害】2026-07-31まで、実在しない 'Crisp Best Ale' が入り、実在する 'Best Ale'(M012)・
// 'Extra Pale Ale'(M013) が欠落し、酵母3品（Crisp Sour/Heritage Lager/Heritage American Ale）を
// 麦芽と誤分類していた。原因＝Ponkichiを見ずにtxtの写しから分類を推定したこと。→ task.md B-077/B-081
window.App = window.App || {};

App.MastersSeed = {
  // fetchedAt: 同梱データである印（実際の取得日時ではない）
  note: '暫定同梱データ（jobs/ponkichi_master_ingredients.txt由来・分類は推定）',

  // ── 仕入先の初期候補（⚠暫定）──
  // 出典：inbox/code.md の入荷実績（Hakko Supply）。Ponkichiの「取引先マスター」を
  // doGet action=read で読めるようになったら、そちらを正としてここは廃止する。
  // 候補に無い仕入先はウィザードの「その他（手入力）」で入力でき、以後は候補に自動追加される。
  suppliers: [
    'Hakko Supply',
  ],

  // ── メーカーの初期候補（⚠暫定）──
  // 出典：CLAUDE.md（Pilsner=Ireks）／jobs/Ponkichi記入定義_仕込み.md（Beech Smoked=Weyermann）／
  // inbox/code.md（Peacharine・Waimea=Freestyle）／原料名（Crisp Best Ale・Crisp Sour=Crisp）。
  // Fermentis・Lallemandは酵母の一般的な製造元として補助的に収録（要確認）。
  // 正しくは原料マスターの「メーカー名」列を参照すべき。読み取り対応後に置き換えること。
  makers: [
    'Crisp',
    'Fermentis',
    'Freestyle',
    'Ireks',
    'Lallemand',
    'Weyermann',
  ],

  // ── 製品名の初期候補（⚠暫定）──
  // 出典：brew_logs / recipes の製品名。正しくはPonkichi「製品マスター」を読み取り対応後に置き換える。
  // 候補に無ければ「その他（手入力）」で入力できる。
  // ⚠ 正式表記＝`PON IPA`／`Trailhead`（2026-07-31 新居さん確定）。ここが揺れると詰口ゲートが
  //    そのままPonkichiに書き込み、表記ゆれが再発する。変えるときは必ず新居さんに正を確認する。
  products: [
    'PON IPA',
    'Palmata',
    'Trailhead',
    '祖武士吟',
    'Reflection',
    'Magic Hour',
  ],

  // ── 容器の初期候補（⚠暫定・容器マスター準拠に要置換）──
  // ⚠ GASは容器名で「容量/本」を引くため、容器名は容器マスターと完全一致が必要（その他手入力は不可）。
  containers: [
    '350mL缶',
    '500mL缶',
    '10L樽',
    '15L樽',
    '20L樽',
  ],

  // 出典＝本番Ponkichi「原料マスター」47件（2026-07-31取得・分類も実データのまま採用。推定はしていない）
  items: [
    // ── 麦芽（原料マスター分類＝麦芽） ──
    { name: 'Acidulated', category: '麦芽' },  // M004
    { name: 'Beech Smoked', category: '麦芽' },  // M006
    { name: 'Best Ale', category: '麦芽' },  // M012
    { name: 'Cara Red', category: '麦芽' },  // M005
    { name: 'CaraMunichⅡ', category: '麦芽' },  // M009
    { name: 'Carafa 3', category: '麦芽' },  // M008
    { name: 'Crystal 150', category: '麦芽' },  // M007
    { name: 'Extra Pale Ale', category: '麦芽' },  // M013
    { name: 'MunichⅠ', category: '麦芽' },  // M011
    { name: 'Pale Ale', category: '麦芽' },  // M010
    { name: 'Pilsner', category: '麦芽' },  // M001
    { name: 'Vienna', category: '麦芽' },  // M003
    { name: 'Wheat Light', category: '麦芽' },  // M002
    // ── ホップ ──
    { name: 'CALLISTA', category: 'ホップ' },  // H005
    { name: 'CHINOOK', category: 'ホップ' },  // H011
    { name: 'CHINOOK CRYO', category: 'ホップ' },  // H010
    { name: 'Comet', category: 'ホップ' },  // H013
    { name: 'GALAXY', category: 'ホップ' },  // H006
    { name: 'HALLERTAU BLANC', category: 'ホップ' },  // H004
    { name: 'Peacharine', category: 'ホップ' },  // H012
    { name: 'SAPHIR', category: 'ホップ' },  // H001
    { name: 'SIMCOE', category: 'ホップ' },  // H007
    { name: 'SPALTER', category: 'ホップ' },  // H002
    { name: 'STYRIAN DRAGON', category: 'ホップ' },  // H009
    { name: 'STYRIAN WOLF', category: 'ホップ' },  // H008
    { name: 'TITAN', category: 'ホップ' },  // H003
    { name: 'Waimea', category: 'ホップ' },  // H014
    // ── 酵母 ──
    { name: 'BE-134', category: '酵母' },  // Y010
    { name: 'Crisp Sour', category: '酵母' },  // Y008
    { name: 'Heritage American Ale', category: '酵母' },  // Y009
    { name: 'Heritage Lager', category: '酵母' },  // Y007
    { name: 'K.22 Stalljen', category: '酵母' },  // Y001
    { name: 'NOTTINGHAM', category: '酵母' },  // Y005
    { name: 'NovaLager', category: '酵母' },  // Y006
    { name: 'US-05', category: '酵母' },  // Y004
    { name: 'W-34/70', category: '酵母' },  // Y003
    { name: 'WB-06', category: '酵母' },  // Y002
    // ── その他の原料（＝入荷ペイロードの「入荷した原料」。原料マスター分類の 麦・米・糖類 と その他 がここに入る） ──
    { name: 'Flaked Oats', category: 'その他の原料' },  // B001・原料マスター分類=麦・米・糖類
    { name: 'そば米', category: 'その他の原料' },  // B002・原料マスター分類=麦・米・糖類
    { name: 'ゆず皮', category: 'その他の原料' },  // O002・原料マスター分類=その他
    { name: 'カラギナン', category: 'その他の原料' },  // O001・原料マスター分類=その他
    { name: '乳糖', category: 'その他の原料' },  // B005・原料マスター分類=麦・米・糖類
    { name: '山椒', category: 'その他の原料' },  // O004・原料マスター分類=その他
    { name: '杉チップ', category: 'その他の原料' },  // O003・原料マスター分類=その他
    { name: '氷砂糖', category: 'その他の原料' },  // B006・原料マスター分類=麦・米・糖類
    { name: '蕎麦の実', category: 'その他の原料' },  // B004・原料マスター分類=麦・米・糖類
    { name: '酒粕', category: 'その他の原料' },  // B003・原料マスター分類=麦・米・糖類
  ],
};
