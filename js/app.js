// ============================================================
// app.js — 一問一答ウィザードの画面制御（データ駆動）。
// 依存：storage.js, masters_seed.js, masters.js, send.js
// 要件定義書§3 UX／§5-1 入荷／§5-2 欠減・測定／§9 落とし穴 を実装。
//
// 設計：ウィザードのエンジンは createWizard(config) に一般化し、
//   入荷(Nyuka)・欠減測定(Hakko) をその上に載せる（画面・確認・送信は共通）。
// ============================================================
(function () {
  'use strict';

  // ── DOM参照 ──
  const $ = function (id) { return document.getElementById(id); };
  const headerTitle = $('header-title');
  const btnBack = $('btn-back');
  const queueBadge = $('queue-badge');

  const screens = {
    home: $('screen-home'),
    settings: $('screen-settings'),
    history: $('screen-history'),
    wizard: $('screen-wizard'),
    confirm: $('screen-confirm'),
    result: $('screen-result'),
  };

  // ウィザード共通DOM
  const wizardStepIndicator = $('wizard-step-indicator');
  const wizardQuestion = $('wizard-question');
  const wizardHint = $('wizard-hint');
  const wizardBody = $('wizard-body');
  const wizardError = $('wizard-error');
  const btnNext = $('btn-wizard-next');

  let currentScreen = 'home';
  let activeWizard = null; // 現在動いているウィザード（入荷 or 欠減測定）

  function showScreen(name) {
    Object.keys(screens).forEach(function (k) { screens[k].hidden = (k !== name); });
    currentScreen = name;
    btnBack.hidden = (name === 'home' || name === 'result');
    const fixed = { home: '剣山醸造所 記帳', settings: '設定', history: '履歴・キュー' };
    let t = fixed[name];
    if (!t && (name === 'wizard' || name === 'confirm' || name === 'result')) {
      t = activeWizard ? activeWizard.title : '記録';
    }
    headerTitle.textContent = t || '剣山醸造所 記帳';
    window.scrollTo(0, 0);
  }

  function updateQueueBadge() {
    const n = App.Storage.getQueue().length;
    queueBadge.hidden = (n === 0);
    queueBadge.textContent = String(n);
  }

  function todayISO() {
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + mm + '-' + dd;
  }

  function setError(msg) {
    if (msg) { wizardError.textContent = msg; wizardError.hidden = false; }
    else { wizardError.hidden = true; wizardError.textContent = ''; }
  }

  // ── 汎用確認モーダル（50kg超・未来日など） ──
  const modal = $('modal-confirm');
  const modalMessage = $('modal-message');
  const modalYes = $('modal-btn-yes');
  const modalNo = $('modal-btn-no');
  function confirmModal(message) {
    return new Promise(function (resolve) {
      modalMessage.textContent = message;
      modal.hidden = false;
      function cleanup(result) {
        modal.hidden = true;
        modalYes.removeEventListener('click', onYes);
        modalNo.removeEventListener('click', onNo);
        resolve(result);
      }
      function onYes() { cleanup(true); }
      function onNo() { cleanup(false); }
      modalYes.addEventListener('click', onYes);
      modalNo.addEventListener('click', onNo);
    });
  }

  // ── 仕入先・メーカー共通：プルダウン＋「その他（手入力）」 ──
  const OTHER_VALUE = '__other__';

  function renderSelectWithOther(body, idBase, candidates, currentValue) {
    const sel = document.createElement('select');
    sel.id = 'select-' + idBase;
    sel.className = 'text-input select-input';
    const ph = document.createElement('option');
    ph.value = '';
    ph.textContent = '— 選んでください —';
    sel.appendChild(ph);
    candidates.forEach(function (c) {
      const o = document.createElement('option');
      o.value = c;
      o.textContent = c;
      sel.appendChild(o);
    });
    const other = document.createElement('option');
    other.value = OTHER_VALUE;
    other.textContent = 'その他（手入力）';
    sel.appendChild(other);
    body.appendChild(sel);

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'input-' + idBase + '-other';
    input.className = 'text-input other-input';
    input.placeholder = '名前を入力してください';
    body.appendChild(input);

    function sync(focus) {
      const isOther = (sel.value === OTHER_VALUE);
      input.style.display = isOther ? 'block' : 'none';
      if (isOther && focus) setTimeout(function () { input.focus(); }, 50);
    }
    sel.addEventListener('change', function () { sync(true); });

    if (currentValue) {
      if (candidates.indexOf(currentValue) !== -1) {
        sel.value = currentValue;
      } else {
        sel.value = OTHER_VALUE;
        input.value = currentValue;
      }
    }
    sync(false);
  }

  function collectSelectWithOther(idBase) {
    const sel = $('select-' + idBase);
    if (sel.value === OTHER_VALUE) return $('input-' + idBase + '-other').value.trim();
    return sel.value;
  }

  // ============================================================
  // ウィザード共通エンジン
  //   config: { title, steps, confirmRows(a), confirmNote?(a), submit(a)->item }
  //   step: { key, title, hint, auto?, autoError?, skipIf?(a),
  //           render(body, ctx), collect?(ctx), validate?(v, ctx) }
  // ============================================================
  function createWizard(config) {
    const STEPS = config.steps;
    let answers = {};
    let stepIndex = 0;

    function isSkipped(i) { const s = STEPS[i]; return !!(s.skipIf && s.skipIf(answers)); }
    function effectiveSteps() { return STEPS.filter(function (s) { return !s.skipIf || !s.skipIf(answers); }); }

    const ctx = {
      get answers() { return answers; },
      goNext: function () { return goNext(); },
      goBack: function () { return goBack(); },
      setError: setError,
      get stepIndex() { return stepIndex; },
      prevStep: function () {
        let i = stepIndex - 1;
        while (i >= 0 && isSkipped(i)) i--;
        if (i >= 0) { stepIndex = i; renderStep(); }
      },
    };

    function renderStep() {
      const step = STEPS[stepIndex];
      const eff = effectiveSteps();
      const pos = eff.indexOf(step) + 1;
      wizardStepIndicator.textContent = pos + ' / ' + eff.length;
      wizardQuestion.textContent = step.title;
      wizardHint.textContent = step.hint || '';
      wizardBody.innerHTML = '';
      setError(null);
      // autoステップ（選択式）は「次へ」を隠す。hidden属性はCSSに負けるためinline styleでも消す。
      btnNext.hidden = !!step.auto;
      btnNext.style.display = step.auto ? 'none' : '';
      step.render(wizardBody, ctx);
    }

    async function goNext() {
      const step = STEPS[stepIndex];
      // 選択式（auto）ステップは、選択して答えが記録されるまで進めない（空欄払出の防止）。
      if (step.auto && !answers[step.key]) {
        setError(step.autoError || '選択してください');
        return;
      }
      if (step.collect && step.validate) {
        const v = step.collect(ctx);
        const result = await step.validate(v, ctx);
        if (!result.ok) { if (result.error) setError(result.error); return; }
      }
      let i = stepIndex + 1;
      while (i < STEPS.length && isSkipped(i)) i++;
      if (i < STEPS.length) { stepIndex = i; renderStep(); }
      else { activeWizard = api; renderConfirm(); showScreen('confirm'); }
    }

    function goBack() {
      let i = stepIndex - 1;
      while (i >= 0 && isSkipped(i)) i--;
      if (i >= 0) { stepIndex = i; renderStep(); }
      else { showScreen('home'); renderHome(); }
    }

    function start() {
      answers = {};
      stepIndex = 0;
      activeWizard = api;
      showScreen('wizard');
      renderStep();
    }

    function backToLastStep() {
      let i = STEPS.length - 1;
      while (i >= 0 && isSkipped(i)) i--;
      stepIndex = i;
      activeWizard = api;
      showScreen('wizard');
      renderStep();
    }

    const api = {
      start: start,
      goBack: goBack,
      backToLastStep: backToLastStep,
      getAnswers: function () { return answers; },
      _goNext: goNext,
      title: config.title,
      confirmRows: config.confirmRows,
      confirmNote: config.confirmNote || null,
      submit: config.submit,
    };
    return api;
  }

  // ============================================================
  // 入荷ウィザード（§5-1）
  // ============================================================
  const Nyuka = createWizard({
    title: '入荷の記録',
    steps: [
      {
        key: 'kubun', title: '区分は？', hint: '入荷した原料の種類を選んでください', auto: true,
        render: function (body, ctx) {
          const options = ['麦芽', 'ホップ', '酵母', 'その他の原料'];
          const wrap = document.createElement('div');
          wrap.className = 'choice-grid';
          options.forEach(function (opt) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'choice-btn'; b.textContent = opt;
            b.addEventListener('click', function () {
              ctx.answers.kubun = opt;
              delete ctx.answers.genryomei; // 区分が変わったら原料名は選び直し
              ctx.goNext();
            });
            wrap.appendChild(b);
          });
          body.appendChild(wrap);
        },
      },
      {
        key: 'genryomei', title: '原料名は？', hint: '', auto: true, autoError: '原料名を選んでください',
        render: function (body, ctx) {
          const kubun = ctx.answers.kubun;
          wizardHint.textContent = '「' + kubun + '」のマスターから選んでください';
          const names = App.Masters.getIngredientNames(kubun);
          if (names.length === 0) {
            const warn = document.createElement('div');
            warn.className = 'block-message';
            warn.innerHTML = '<p>⚠「' + kubun + '」に登録されている原料がマスターにありません。</p>' +
              '<p>先にマスター登録が必要です。設定画面で「マスターを再取得する」を試すか、' +
              'Ponkichi側の原料マスターに登録してから再度お試しください。</p>';
            body.appendChild(warn);
            const btnSettings = document.createElement('button');
            btnSettings.type = 'button'; btnSettings.className = 'secondary-btn'; btnSettings.textContent = '設定画面へ';
            btnSettings.addEventListener('click', function () { showScreen('settings'); renderSettings(); });
            body.appendChild(btnSettings);
            const btnRedo = document.createElement('button');
            btnRedo.type = 'button'; btnRedo.className = 'secondary-btn'; btnRedo.textContent = '区分をやり直す';
            btnRedo.addEventListener('click', function () { ctx.prevStep(); });
            body.appendChild(btnRedo);
            return;
          }
          const wrap = document.createElement('div');
          wrap.className = 'choice-list';
          names.forEach(function (name) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'choice-btn choice-btn--list'; b.textContent = name;
            b.addEventListener('click', function () { ctx.answers.genryomei = name; ctx.goNext(); });
            wrap.appendChild(b);
          });
          body.appendChild(wrap);
        },
      },
      {
        key: 'suryo', title: '数量は？（g）', hint: '数値のみ入力してください（例：25000）',
        render: function (body, ctx) {
          const input = document.createElement('input');
          input.type = 'number'; input.inputMode = 'decimal'; input.min = '0'; input.step = '1';
          input.id = 'input-suryo'; input.className = 'text-input text-input--number'; input.placeholder = '例：25000';
          if (ctx.answers.suryo) input.value = ctx.answers.suryo;
          body.appendChild(input);
          const unit = document.createElement('p'); unit.className = 'unit-note'; unit.textContent = '単位：g（グラム）';
          body.appendChild(unit);
          setTimeout(function () { input.focus(); }, 50);
        },
        collect: function () { return $('input-suryo').value; },
        validate: async function (v, ctx) {
          if (v === '' || v === null) return { ok: false, error: '数量を入力してください' };
          const n = Number(v);
          if (!isFinite(n) || n <= 0) return { ok: false, error: '正しい数値を入力してください' };
          if (n > 50000) {
            const ok = await confirmModal('50kgを超えています（' + n + 'g）。よろしいですか？');
            if (!ok) return { ok: false, error: null };
          }
          ctx.answers.suryo = n;
          return { ok: true };
        },
      },
      {
        key: 'nyukabi', title: '入荷日は？', hint: '',
        render: function (body, ctx) {
          const input = document.createElement('input');
          input.type = 'date'; input.id = 'input-nyukabi'; input.className = 'text-input';
          input.value = ctx.answers.nyukabi || todayISO();
          body.appendChild(input);
        },
        collect: function () { return $('input-nyukabi').value; },
        validate: async function (v, ctx) {
          if (!v) return { ok: false, error: '入荷日を入力してください' };
          if (v > todayISO()) {
            const ok = await confirmModal('未来の日付です（' + v + '）。よろしいですか？');
            if (!ok) return { ok: false, error: null };
          }
          ctx.answers.nyukabi = v;
          return { ok: true };
        },
      },
      {
        key: 'shiirasaki', title: '仕入先は？', hint: '候補から選んでください。無ければ「その他（手入力）」',
        render: function (body, ctx) {
          renderSelectWithOther(body, 'shiirasaki', App.Masters.getSupplierCandidates(),
            ctx.answers.shiirasaki || App.Storage.getLastSupplier() || '');
        },
        collect: function () { return collectSelectWithOther('shiirasaki'); },
        validate: function (v, ctx) {
          if (!v) return { ok: false, error: '仕入先を選ぶか、手入力してください' };
          ctx.answers.shiirasaki = v; return { ok: true };
        },
      },
      {
        key: 'maker', title: 'メーカーは？', hint: '候補から選んでください。無ければ「その他（手入力）」',
        render: function (body, ctx) {
          renderSelectWithOther(body, 'maker', App.Masters.getMakerCandidates(),
            ctx.answers.maker || App.Storage.getLastMaker() || '');
        },
        collect: function () { return collectSelectWithOther('maker'); },
        validate: function (v, ctx) {
          if (!v) return { ok: false, error: 'メーカーを選ぶか、手入力してください' };
          ctx.answers.maker = v; return { ok: true };
        },
      },
      {
        key: 'kirokusha', title: '記録者は？', hint: '',
        render: function (body, ctx) {
          const last = App.Storage.getLastRecorder();
          if (last) {
            const quick = document.createElement('button');
            quick.type = 'button'; quick.className = 'choice-btn'; quick.textContent = '前回と同じ：' + last;
            quick.addEventListener('click', function () { ctx.answers.kirokusha = last; ctx.goNext(); });
            body.appendChild(quick);
          }
          const input = document.createElement('input');
          input.type = 'text'; input.id = 'input-kirokusha'; input.className = 'text-input';
          input.value = ctx.answers.kirokusha || last || '';
          body.appendChild(input);
        },
        collect: function () { return $('input-kirokusha').value.trim(); },
        validate: function (v, ctx) {
          if (!v) return { ok: false, error: '記録者を入力してください' };
          ctx.answers.kirokusha = v; return { ok: true };
        },
      },
    ],
    confirmRows: function (a) {
      return [
        ['区分', a.kubun], ['原料名', a.genryomei], ['数量', a.suryo + ' g'],
        ['入荷日', a.nyukabi], ['仕入先', a.shiirasaki], ['メーカー', a.maker], ['記録者', a.kirokusha],
      ];
    },
    submit: function (a) { return App.Send.enqueue(a); },
  });

  // ============================================================
  // 欠減・測定ウィザード（§5-2・event_type=発酵管理）
  // ============================================================
  const HAKKO_MEASURE = ['比重測定', 'アルコール分析'];
  function isMeasure(a) { return HAKKO_MEASURE.indexOf(a.kind) !== -1; }
  function isLoss(a) { return a.kind === '澱引き' || a.kind === 'その他'; }

  const Hakko = createWizard({
    title: '欠減・測定の記録',
    steps: [
      {
        key: 'batchNo', title: 'どのバッチ？', hint: 'バッチ番号を入力してください（例：18）',
        render: function (body, ctx) {
          const input = document.createElement('input');
          input.type = 'text'; input.inputMode = 'numeric'; input.id = 'input-batchno';
          input.className = 'text-input'; input.placeholder = '例：18';
          if (ctx.answers.batchNo) input.value = ctx.answers.batchNo;
          body.appendChild(input);
          const note = document.createElement('p'); note.className = 'unit-note';
          note.textContent = '※ 仕込み帳簿のバッチ番号（#つきで記録されます）';
          body.appendChild(note);
          setTimeout(function () { input.focus(); }, 50);
        },
        collect: function () { return $('input-batchno').value.trim(); },
        validate: function (v, ctx) {
          if (!v) return { ok: false, error: 'バッチ番号を入力してください' };
          const b = v.replace(/^#*/, '');
          if (!/^\d+$/.test(b)) return { ok: false, error: '数字で入力してください（例：18）' };
          ctx.answers.batchNo = '#' + b;
          return { ok: true };
        },
      },
      {
        key: 'kind', title: '何を記録しますか？', hint: '', auto: true, autoError: '選んでください',
        render: function (body, ctx) {
          const opts = ['比重測定', 'アルコール分析', '澱引き', 'その他'];
          const wrap = document.createElement('div'); wrap.className = 'choice-list';
          opts.forEach(function (o) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'choice-btn choice-btn--list'; b.textContent = o;
            b.addEventListener('click', function () { ctx.answers.kind = o; ctx.goNext(); });
            wrap.appendChild(b);
          });
          body.appendChild(wrap);
        },
      },
      {
        key: 'hijyu', title: '現在の比重は？', hint: '測ったら入力（任意・分からなければ空欄で次へ）',
        skipIf: function (a) { return !isMeasure(a); },
        render: function (body, ctx) {
          const input = document.createElement('input');
          input.type = 'text'; input.inputMode = 'decimal'; input.id = 'input-hijyu';
          input.className = 'text-input'; input.placeholder = '例：1.012';
          if (ctx.answers.hijyu) input.value = ctx.answers.hijyu;
          body.appendChild(input);
          const note = document.createElement('p'); note.className = 'unit-note';
          note.textContent = 'アルコール分析のときは、入れると度数が更新されます';
          body.appendChild(note);
          setTimeout(function () { input.focus(); }, 50);
        },
        collect: function () { return $('input-hijyu').value.trim(); },
        validate: function (v, ctx) {
          if (v) { const n = Number(v); if (!isFinite(n)) return { ok: false, error: '数値で入力してください（例：1.012）' }; }
          ctx.answers.hijyu = v; // ⚠ 文字列のまま保持（1.000→1 の精度落ちを避ける）
          return { ok: true };
        },
      },
      {
        key: 'sokuteiMl', title: '測定で抜いた量は？（ml）', hint: 'サンプルとして抜いた液量',
        skipIf: function (a) { return !isMeasure(a); },
        render: function (body, ctx) {
          const input = document.createElement('input');
          input.type = 'number'; input.inputMode = 'decimal'; input.min = '0';
          input.id = 'input-sokuteiml'; input.className = 'text-input text-input--number'; input.placeholder = '例：50';
          if (ctx.answers.sokuteiMl != null) input.value = ctx.answers.sokuteiMl;
          body.appendChild(input);
          const note = document.createElement('p'); note.className = 'unit-note'; note.textContent = '単位：ml（ミリリットル）';
          body.appendChild(note);
          setTimeout(function () { input.focus(); }, 50);
        },
        collect: function () { return $('input-sokuteiml').value; },
        validate: async function (v, ctx) {
          if (v === '' || v == null) return { ok: false, error: '量を入力してください' };
          const n = Number(v);
          if (!isFinite(n) || n < 0) return { ok: false, error: '正しい数値を入力してください' };
          if (n > 1000) {
            const ok = await confirmModal('1,000mlを超えています（' + n + 'ml）。よろしいですか？');
            if (!ok) return { ok: false, error: null };
          }
          ctx.answers.sokuteiMl = n;
          return { ok: true };
        },
      },
      {
        key: 'sonotaL', title: '抜いた／捨てた量は？（L）', hint: '澱引きなどで抜いた液量',
        skipIf: function (a) { return !isLoss(a); },
        render: function (body, ctx) {
          const input = document.createElement('input');
          input.type = 'number'; input.inputMode = 'decimal'; input.min = '0';
          input.id = 'input-sonotal'; input.className = 'text-input text-input--number'; input.placeholder = '例：2';
          if (ctx.answers.sonotaL != null) input.value = ctx.answers.sonotaL;
          body.appendChild(input);
          const note = document.createElement('p'); note.className = 'unit-note'; note.textContent = '単位：L（リットル）';
          body.appendChild(note);
          setTimeout(function () { input.focus(); }, 50);
        },
        collect: function () { return $('input-sonotal').value; },
        validate: function (v, ctx) {
          if (v === '' || v == null) return { ok: false, error: '量を入力してください' };
          const n = Number(v);
          if (!isFinite(n) || n <= 0) return { ok: false, error: '正しい数値を入力してください' };
          ctx.answers.sonotaL = n;
          return { ok: true };
        },
      },
      {
        key: 'riyu', title: '理由は？', hint: '例：底の澱引き',
        skipIf: function (a) { return !isLoss(a); },
        render: function (body, ctx) {
          const input = document.createElement('input');
          input.type = 'text'; input.id = 'input-riyu'; input.className = 'text-input';
          input.value = ctx.answers.riyu || (ctx.answers.kind === '澱引き' ? '澱引き' : '');
          body.appendChild(input);
          setTimeout(function () { input.focus(); }, 50);
        },
        collect: function () { return $('input-riyu').value.trim(); },
        validate: function (v, ctx) {
          if (!v) return { ok: false, error: '理由を入力してください' };
          const hit = App.Send.reasonForbiddenHit(v);
          if (hit.length > 0) return { ok: false, error: '「' + hit.join('・') + '」は専用フローで記録します。別の言葉にしてください' };
          ctx.answers.riyu = v;
          return { ok: true };
        },
      },
      {
        key: 'kirokubi', title: '記録日は？', hint: '',
        render: function (body, ctx) {
          const input = document.createElement('input');
          input.type = 'date'; input.id = 'input-kirokubi'; input.className = 'text-input';
          input.value = ctx.answers.kirokubi || todayISO();
          body.appendChild(input);
        },
        collect: function () { return $('input-kirokubi').value; },
        validate: async function (v, ctx) {
          if (!v) return { ok: false, error: '記録日を入力してください' };
          if (v > todayISO()) {
            const ok = await confirmModal('未来の日付です（' + v + '）。よろしいですか？');
            if (!ok) return { ok: false, error: null };
          }
          ctx.answers.kirokubi = v;
          return { ok: true };
        },
      },
      {
        key: 'kirokusha', title: '記録者は？', hint: '',
        render: function (body, ctx) {
          const last = App.Storage.getLastRecorder();
          if (last) {
            const quick = document.createElement('button');
            quick.type = 'button'; quick.className = 'choice-btn'; quick.textContent = '前回と同じ：' + last;
            quick.addEventListener('click', function () { ctx.answers.kirokusha = last; ctx.goNext(); });
            body.appendChild(quick);
          }
          const input = document.createElement('input');
          input.type = 'text'; input.id = 'input-kirokusha-h'; input.className = 'text-input';
          input.value = ctx.answers.kirokusha || last || '';
          body.appendChild(input);
        },
        collect: function () { return $('input-kirokusha-h').value.trim(); },
        validate: function (v, ctx) {
          if (!v) return { ok: false, error: '記録者を入力してください' };
          ctx.answers.kirokusha = v; return { ok: true };
        },
      },
    ],
    confirmRows: function (a) {
      const rows = [['バッチ', a.batchNo], ['記録種別', a.kind]];
      if (isMeasure(a)) {
        if (a.hijyu) rows.push(['現在の比重', a.hijyu]);
        rows.push(['測定で抜いた量', a.sokuteiMl + ' ml']);
      } else {
        rows.push(['抜いた／捨てた量', a.sonotaL + ' L']);
        rows.push(['理由', a.riyu]);
      }
      rows.push(['記録日', a.kirokubi]);
      rows.push(['記録者', a.kirokusha]);
      return rows;
    },
    confirmNote: function (a) {
      if (isLoss(a)) {
        return '⚠ 酒類を抜き出して廃棄する場合は、税務署への届出が必要なことがあります。届出をお忘れなく。';
      }
      return null;
    },
    submit: function (a) { return App.Send.enqueueHakko(a); },
  });

  // ============================================================
  // BT移送ウィザード（§5-3・event_type=発酵管理・理由=ブライトタンク移送）
  // ============================================================
  const BT = createWizard({
    title: 'BT移送の記録',
    steps: [
      {
        key: 'batchNo', title: 'どのバッチ？', hint: 'バッチ番号を入力してください（例：18）',
        render: function (body, ctx) {
          const input = document.createElement('input');
          input.type = 'text'; input.inputMode = 'numeric'; input.id = 'input-bt-batchno';
          input.className = 'text-input'; input.placeholder = '例：18';
          if (ctx.answers.batchNo) input.value = ctx.answers.batchNo;
          body.appendChild(input);
          const note = document.createElement('p'); note.className = 'unit-note';
          note.textContent = '※ 発酵タンク(FV)から移したブライトタンクへの記録です';
          body.appendChild(note);
          setTimeout(function () { input.focus(); }, 50);
        },
        collect: function () { return $('input-bt-batchno').value.trim(); },
        validate: function (v, ctx) {
          if (!v) return { ok: false, error: 'バッチ番号を入力してください' };
          const b = v.replace(/^#*/, '');
          if (!/^\d+$/.test(b)) return { ok: false, error: '数字で入力してください（例：18）' };
          ctx.answers.batchNo = '#' + b;
          return { ok: true };
        },
      },
      {
        key: 'transferTo', title: '移送先は？', hint: 'どのブライトタンクへ移しましたか', auto: true, autoError: '移送先を選んでください',
        render: function (body, ctx) {
          const opts = ['BT1', 'BT2'];
          const wrap = document.createElement('div'); wrap.className = 'choice-grid';
          opts.forEach(function (o) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'choice-btn'; b.textContent = o;
            b.addEventListener('click', function () { ctx.answers.transferTo = o; ctx.goNext(); });
            wrap.appendChild(b);
          });
          body.appendChild(wrap);
        },
      },
      {
        key: 'gensuiL', title: '移送で失った量は？（L）', hint: 'タンク底の残りなど。無ければ 0',
        render: function (body, ctx) {
          const input = document.createElement('input');
          input.type = 'number'; input.inputMode = 'decimal'; input.min = '0';
          input.id = 'input-bt-gensui'; input.className = 'text-input text-input--number'; input.placeholder = '例：8';
          if (ctx.answers.gensuiL != null) input.value = ctx.answers.gensuiL;
          body.appendChild(input);
          const note = document.createElement('p'); note.className = 'unit-note'; note.textContent = '単位：L（リットル）／無ければ 0';
          body.appendChild(note);
          setTimeout(function () { input.focus(); }, 50);
        },
        collect: function () { return $('input-bt-gensui').value; },
        validate: function (v, ctx) {
          if (v === '' || v == null) return { ok: false, error: '量を入力してください（無ければ 0）' };
          const n = Number(v);
          if (!isFinite(n) || n < 0) return { ok: false, error: '0以上の数値を入力してください' };
          ctx.answers.gensuiL = n;
          return { ok: true };
        },
      },
      {
        key: 'hosoku', title: '補足があれば（任意）', hint: '無ければ空欄のまま「次へ」',
        render: function (body, ctx) {
          const input = document.createElement('input');
          input.type = 'text'; input.id = 'input-bt-hosoku'; input.className = 'text-input';
          input.placeholder = '例：配管ロス多め';
          if (ctx.answers.hosoku) input.value = ctx.answers.hosoku;
          body.appendChild(input);
        },
        collect: function () { return $('input-bt-hosoku').value.trim(); },
        validate: async function (v, ctx) {
          if (v && v.indexOf('アルコール分析') !== -1) {
            return { ok: false, error: '「アルコール分析」は使えません（度数の誤更新を防ぐため）' };
          }
          // B-064・§4-3：推定・届出要否・訂正経緯等の記載はここに書かない（警告のみ）
          if (v) {
            const hits = App.Send.checkBikoForbidden(v);
            if (hits.length > 0) {
              const ok = await confirmModal(
                '⚠ この補足には次の内容が含まれているようです：\n「' + hits.join('」「') + '」\n\n' +
                '推定・届出要否・訂正の経緯などは書かず、事実だけを記録してください。\n' +
                'このまま進めますか？'
              );
              if (!ok) return { ok: false, error: null };
            }
          }
          ctx.answers.hosoku = v;
          return { ok: true };
        },
      },
      {
        key: 'kirokubi', title: '移送した日は？', hint: '',
        render: function (body, ctx) {
          const input = document.createElement('input');
          input.type = 'date'; input.id = 'input-bt-kirokubi'; input.className = 'text-input';
          input.value = ctx.answers.kirokubi || todayISO();
          body.appendChild(input);
        },
        collect: function () { return $('input-bt-kirokubi').value; },
        validate: async function (v, ctx) {
          if (!v) return { ok: false, error: '日付を入力してください' };
          if (v > todayISO()) {
            const ok = await confirmModal('未来の日付です（' + v + '）。よろしいですか？');
            if (!ok) return { ok: false, error: null };
          }
          ctx.answers.kirokubi = v;
          return { ok: true };
        },
      },
      {
        key: 'kirokusha', title: '記録者は？', hint: '',
        render: function (body, ctx) {
          const last = App.Storage.getLastRecorder();
          if (last) {
            const quick = document.createElement('button');
            quick.type = 'button'; quick.className = 'choice-btn'; quick.textContent = '前回と同じ：' + last;
            quick.addEventListener('click', function () { ctx.answers.kirokusha = last; ctx.goNext(); });
            body.appendChild(quick);
          }
          const input = document.createElement('input');
          input.type = 'text'; input.id = 'input-bt-kirokusha'; input.className = 'text-input';
          input.value = ctx.answers.kirokusha || last || '';
          body.appendChild(input);
        },
        collect: function () { return $('input-bt-kirokusha').value.trim(); },
        validate: function (v, ctx) {
          if (!v) return { ok: false, error: '記録者を入力してください' };
          ctx.answers.kirokusha = v; return { ok: true };
        },
      },
    ],
    confirmRows: function (a) {
      return [
        ['バッチ', a.batchNo],
        ['移送先', a.transferTo],
        ['移送で失った量', a.gensuiL + ' L'],
        ['補足', a.hosoku || '（なし）'],
        ['移送日', a.kirokubi],
        ['記録者', a.kirokusha],
      ];
    },
    confirmNote: function () {
      return 'ℹ 移送後のブライトタンク受入量は、Ponkichiが「仕込み液量−これまでの欠減」で自動計算します。';
    },
    submit: function (a) { return App.Send.enqueueBT(a); },
  });

  // ============================================================
  // 詰口ウィザード（§5-4・event_type=製品化）
  //   ※ 1送信=1容器。缶＋樽は「続けて記録」で繰り返す。
  // ============================================================
  const Seihin = createWizard({
    title: '詰口の記録',
    steps: [
      {
        key: 'batchNo', title: 'どのバッチ？', hint: 'バッチ番号を入力してください（例：18）',
        render: function (body, ctx) {
          const input = document.createElement('input');
          input.type = 'text'; input.inputMode = 'numeric'; input.id = 'input-s-batchno';
          input.className = 'text-input'; input.placeholder = '例：18';
          if (ctx.answers.batchNo) input.value = ctx.answers.batchNo;
          body.appendChild(input);
          setTimeout(function () { input.focus(); }, 50);
        },
        collect: function () { return $('input-s-batchno').value.trim(); },
        validate: function (v, ctx) {
          if (!v) return { ok: false, error: 'バッチ番号を入力してください' };
          const b = v.replace(/^#*/, '');
          if (!/^\d+$/.test(b)) return { ok: false, error: '数字で入力してください（例：18）' };
          ctx.answers.batchNo = '#' + b;
          return { ok: true };
        },
      },
      {
        key: 'seihinmei', title: '製品名は？', hint: '候補から選んでください。無ければ「その他（手入力）」',
        render: function (body, ctx) {
          renderSelectWithOther(body, 'seihinmei', App.Masters.getProductCandidates(), ctx.answers.seihinmei || '');
        },
        collect: function () { return collectSelectWithOther('seihinmei'); },
        validate: function (v, ctx) {
          if (!v) return { ok: false, error: '製品名を選ぶか、手入力してください' };
          ctx.answers.seihinmei = v; return { ok: true };
        },
      },
      {
        // 🔴 2026-10-19追加：この質問が無く、送信fieldsの「製品化（容器充填）日」が空で飛んでいた。
        //   空日付は ①詰口簿・製品受払簿の日付が空欄 ②B-092のdecideYoukiBangouが
        //   「記録日≦BT受入日」側に倒れて亡失3行の容器番号がFV固定、の二重の誤記帳になる。
        //   本番の「アプリ記帳ログ」が未作成＝アプリからの着地は1件も無く、実害は出ていない。
        key: 'seihinbi', title: '詰めた日は？', hint: '製品化（容器充填）日として記録します',
        render: function (body, ctx) {
          const input = document.createElement('input');
          input.type = 'date'; input.id = 'input-s-seihinbi'; input.className = 'text-input';
          input.value = ctx.answers.seihinbi || todayISO();
          body.appendChild(input);
        },
        collect: function () { return $('input-s-seihinbi').value; },
        validate: async function (v, ctx) {
          if (!v) return { ok: false, error: '詰めた日を入力してください' };
          if (v > todayISO()) {
            const ok = await confirmModal('未来の日付です（' + v + '）。よろしいですか？');
            if (!ok) return { ok: false, error: null };
          }
          ctx.answers.seihinbi = v;
          return { ok: true };
        },
      },
      {
        key: 'youki', title: '容器は？', hint: 'ひとつの容器につき1回ずつ記録します', auto: true, autoError: '容器を選んでください',
        render: function (body, ctx) {
          const cands = App.Masters.getContainerCandidates();
          const wrap = document.createElement('div'); wrap.className = 'choice-list';
          cands.forEach(function (c) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'choice-btn choice-btn--list'; b.textContent = c;
            b.addEventListener('click', function () { ctx.answers.youki = c; ctx.goNext(); });
            wrap.appendChild(b);
          });
          body.appendChild(wrap);
        },
      },
      {
        key: 'honsu', title: '本数は？', hint: '詰めた本数（缶・樽の数）',
        render: function (body, ctx) {
          const input = document.createElement('input');
          input.type = 'number'; input.inputMode = 'numeric'; input.min = '1'; input.step = '1';
          input.id = 'input-s-honsu'; input.className = 'text-input text-input--number'; input.placeholder = '例：631';
          if (ctx.answers.honsu != null) input.value = ctx.answers.honsu;
          body.appendChild(input);
          const note = document.createElement('p'); note.className = 'unit-note'; note.textContent = '単位：本';
          body.appendChild(note);
          setTimeout(function () { input.focus(); }, 50);
        },
        collect: function () { return $('input-s-honsu').value; },
        validate: function (v, ctx) {
          if (v === '' || v == null) return { ok: false, error: '本数を入力してください' };
          const n = Number(v);
          if (!Number.isInteger(n) || n <= 0) return { ok: false, error: '1以上の整数を入力してください' };
          ctx.answers.honsu = n; return { ok: true };
        },
      },
      {
        key: 'fg', title: '最終比重（FG）は？', hint: '測っていれば入力（任意・分からなければ空欄で次へ）',
        render: function (body, ctx) {
          const input = document.createElement('input');
          input.type = 'text'; input.inputMode = 'decimal'; input.id = 'input-s-fg';
          input.className = 'text-input'; input.placeholder = '例：1.008';
          if (ctx.answers.fg) input.value = ctx.answers.fg;
          body.appendChild(input);
          setTimeout(function () { input.focus(); }, 50);
        },
        collect: function () { return $('input-s-fg').value.trim(); },
        validate: function (v, ctx) {
          if (v) { const n = Number(v); if (!isFinite(n)) return { ok: false, error: '数値で入力してください（例：1.008）' }; }
          ctx.answers.fg = v; // 文字列のまま保持
          return { ok: true };
        },
      },
      {
        key: 'pkgLossMl', title: '充填で失った量は？（mL）', hint: '配管残・充填ロスなど。無ければ 0',
        render: function (body, ctx) {
          const input = document.createElement('input');
          input.type = 'number'; input.inputMode = 'decimal'; input.min = '0';
          input.id = 'input-s-pkgloss'; input.className = 'text-input text-input--number'; input.placeholder = '例：500';
          if (ctx.answers.pkgLossMl != null) input.value = ctx.answers.pkgLossMl;
          body.appendChild(input);
          const note = document.createElement('p'); note.className = 'unit-note'; note.textContent = '単位：mL／無ければ 0';
          body.appendChild(note);
          setTimeout(function () { input.focus(); }, 50);
        },
        collect: function () { return $('input-s-pkgloss').value; },
        validate: function (v, ctx) {
          if (v === '' || v == null) return { ok: false, error: '量を入力してください（無ければ 0）' };
          const n = Number(v);
          if (!isFinite(n) || n < 0) return { ok: false, error: '0以上の数値を入力してください' };
          ctx.answers.pkgLossMl = n; return { ok: true };
        },
      },
      {
        key: 'isLast', title: 'このバッチの充填は最後ですか？', hint: 'タンクは空になりましたか？', auto: true, autoError: 'どちらか選んでください',
        render: function (body, ctx) {
          const opts = ['はい', 'いいえ'];
          const wrap = document.createElement('div'); wrap.className = 'choice-grid';
          opts.forEach(function (o) {
            const b = document.createElement('button');
            b.type = 'button'; b.className = 'choice-btn'; b.textContent = o;
            b.addEventListener('click', function () { ctx.answers.isLast = o; ctx.goNext(); });
            wrap.appendChild(b);
          });
          body.appendChild(wrap);
        },
      },
      {
        // 🔴 2026-10-19追加：この質問が無く「タンク底の澱(L)」を送っていなかった。
        //   processSeihinka は「はい」のときだけこの値を読み、①工程内亡失(澱廃棄)の行を作る
        //   ②パッケージ欠減（残差）から差し引く、の2つに使う（schema §A-4）。
        //   送らないと澱廃棄の行が立たず、その分がパッケージ欠減に乗る＝欠減の内訳が実態と違う。
        key: 'oriL', title: 'タンク底の澱は？（L）', hint: 'トラブ・酵母などの廃棄量。無ければ 0',
        skipIf: function (a) { return a.isLast !== 'はい'; },
        render: function (body, ctx) {
          const input = document.createElement('input');
          input.type = 'number'; input.inputMode = 'decimal'; input.min = '0';
          input.id = 'input-s-ori'; input.className = 'text-input text-input--number'; input.placeholder = '例：6';
          if (ctx.answers.oriL != null) input.value = ctx.answers.oriL;
          body.appendChild(input);
          const note = document.createElement('p'); note.className = 'unit-note';
          note.textContent = '単位：L（リットル）／無ければ 0';
          body.appendChild(note);
          setTimeout(function () { input.focus(); }, 50);
        },
        collect: function () { return $('input-s-ori').value; },
        validate: function (v, ctx) {
          if (v === '' || v == null) return { ok: false, error: '量を入力してください（無ければ 0）' };
          const n = Number(v);
          if (!isFinite(n) || n < 0) return { ok: false, error: '0以上の数値を入力してください' };
          ctx.answers.oriL = n;
          return { ok: true };
        },
      },
      {
        key: 'bikou', title: '備考があれば（任意）', hint: '無ければ空欄のまま「次へ」。事実だけを書いてください（推測や経緯は書かない）',
        render: function (body, ctx) {
          const input = document.createElement('input');
          input.type = 'text'; input.id = 'input-s-bikou'; input.className = 'text-input';
          input.placeholder = '（任意）';
          if (ctx.answers.bikou) input.value = ctx.answers.bikou;
          body.appendChild(input);
        },
        collect: function () { return $('input-s-bikou').value.trim(); },
        // B-064・§4-3：推定・見込み・届出要否・訂正経緯等の記載はここに書かない（警告のみ・機械的拒否はしない）
        validate: async function (v, ctx) {
          if (v) {
            const hits = App.Send.checkBikoForbidden(v);
            if (hits.length > 0) {
              const ok = await confirmModal(
                '⚠ この備考には次の内容が含まれているようです：\n「' + hits.join('」「') + '」\n\n' +
                '推定・届出要否・訂正の経緯などは備考欄に書かず、事実だけを記録してください。\n' +
                'このまま進めますか？'
              );
              if (!ok) return { ok: false, error: null };
            }
          }
          ctx.answers.bikou = v;
          return { ok: true };
        },
      },
      {
        key: 'kirokusha', title: '記録者は？', hint: '',
        render: function (body, ctx) {
          const last = App.Storage.getLastRecorder();
          if (last) {
            const quick = document.createElement('button');
            quick.type = 'button'; quick.className = 'choice-btn'; quick.textContent = '前回と同じ：' + last;
            quick.addEventListener('click', function () { ctx.answers.kirokusha = last; ctx.goNext(); });
            body.appendChild(quick);
          }
          const input = document.createElement('input');
          input.type = 'text'; input.id = 'input-s-kirokusha'; input.className = 'text-input';
          input.value = ctx.answers.kirokusha || last || '';
          body.appendChild(input);
        },
        collect: function () { return $('input-s-kirokusha').value.trim(); },
        validate: function (v, ctx) {
          if (!v) return { ok: false, error: '記録者を入力してください' };
          ctx.answers.kirokusha = v; return { ok: true };
        },
      },
    ],
    confirmRows: function (a) {
      return [
        ['バッチ', a.batchNo],
        ['製品名', a.seihinmei],
        ['詰めた日', a.seihinbi],
        ['容器', a.youki],
        ['本数', a.honsu + ' 本'],
        ['最終比重(FG)', a.fg || '（未入力）'],
        ['充填で失った量', a.pkgLossMl + ' mL'],
        ['このバッチ最後？', a.isLast],
        ['タンク底の澱', a.isLast === 'はい' ? (a.oriL + ' L') : '（最後でないため記録しません）'],
        ['備考', a.bikou || '（なし）'],
        ['記録者', a.kirokusha],
      ];
    },
    confirmNote: function () {
      return 'ℹ 送信すると製品受払簿・詰口簿へ記帳し、仕込み帳簿のFG・度数・精製量も更新されます。缶と樽の両方があるときは、送信後「続けて記録」でもう一方を入力してください。';
    },
    submit: function (a) { return App.Send.enqueueSeihin(a); },
  });

  // ============================================================
  // 出荷ウィザード（§5-5・event_type=出荷 / processShukka）
  //   新居さん指示（2026-10-19）：出荷は都度入力が理想。Claude経由では時間がかかる。
  //
  // 設計の要：processShukka は「出荷製品・バッチ」を **1本の文字列** で受けて
  //   正規表現で製品名／容器／バッチNoに割る。手入力させると形が崩れてバッチNoが
  //   '（不明）' で着地するため、選択肢は **製品受払簿の在庫（受入−払出）から機械的に組む**。
  //   在庫が無い組み合わせは出さない（払出超過＝台帳の在庫がマイナスになる事故の防止）。
  // ============================================================
  const STOCK_STALE_MS = 10 * 60 * 1000; // 10分より古いスナップショットは開いた時に裏で取り直す
  let stockFetching = false;

  // 在庫スナップショットから「いま押せる残り本数」を出す（キューに残っている出荷分を差し引く）
  function availableQty(item) {
    return (Number(item.qty) || 0) - App.Send.reservedShukkaQty(item.label);
  }

  function findStockByLabel(label) {
    const items = App.Masters.getActiveStock().items || [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].label === label) return items[i];
    }
    return null;
  }

  function renderStockChoices(body, ctx) {
    body.innerHTML = '';
    const stock = App.Masters.getActiveStock();
    const items = (stock.items || []).filter(function (it) { return availableQty(it) > 0; });

    if (items.length === 0) {
      const warn = document.createElement('div');
      warn.className = 'block-message';
      warn.innerHTML = stock.fetchedAt
        ? '<p>⚠ 出荷できる在庫がある製品が見つかりません。</p>' +
          '<p>詰口（製品化）の記録がまだなら、先に詰口を記録してください。' +
          '在庫は製品受払簿の「受入(製造)−払出(出荷)」で判定しています。</p>'
        : '<p>⚠ 在庫データをまだ取得していません。</p>' +
          '<p>オンラインのときに「最新の在庫を取得」を押してください。' +
          '出荷は製品名・容器・バッチの組み合わせが正確でないと記帳できないため、手入力はできません。</p>';
      body.appendChild(warn);
    } else {
      const wrap = document.createElement('div');
      wrap.className = 'choice-list';
      items.forEach(function (it) {
        const b = document.createElement('button');
        b.type = 'button'; b.className = 'choice-btn choice-btn--list';
        b.innerHTML = escapeHtml(it.label) +
          '<br><small class="choice-sub">残り ' + availableQty(it) + '</small>';
        b.addEventListener('click', function () {
          ctx.answers.productLabel = it.label;
          ctx.answers.productMax = availableQty(it);
          ctx.goNext();
        });
        wrap.appendChild(b);
      });
      body.appendChild(wrap);
    }

    const note = document.createElement('p');
    note.className = 'unit-note';
    note.textContent = stock.fetchedAt
      ? '在庫データ：' + new Date(stock.fetchedAt).toLocaleString('ja-JP') + ' 時点'
      : '在庫データ：未取得';
    body.appendChild(note);

    const btnRefresh = document.createElement('button');
    btnRefresh.type = 'button'; btnRefresh.className = 'secondary-btn';
    btnRefresh.textContent = stockFetching ? '取得中…' : '🔄 最新の在庫を取得';
    btnRefresh.disabled = stockFetching;
    btnRefresh.addEventListener('click', function () { doRefreshStock(body, ctx, true); });
    body.appendChild(btnRefresh);

    // 古い／未取得なら、開いた時点で一度だけ裏で取り直す（オフラインなら静かに失敗してキャッシュを使う）
    const age = stock.fetchedAt ? (Date.now() - new Date(stock.fetchedAt).getTime()) : Infinity;
    if (!stockFetching && age > STOCK_STALE_MS) doRefreshStock(body, ctx, false);
  }

  function doRefreshStock(body, ctx, showError) {
    const url = App.Storage.getBridgeUrl();
    if (!url) { if (showError) setError('送信先URLが未設定です（設定画面で入力してください）'); return; }
    stockFetching = true;
    App.Masters.refreshStock(url).then(function () {
      stockFetching = false;
      if (currentScreen === 'wizard') { setError(null); renderStockChoices(body, ctx); }
    }, function (err) {
      stockFetching = false;
      if (currentScreen === 'wizard') {
        if (showError) setError('在庫を取得できませんでした（' + String(err && err.message || err) + '）');
        renderStockChoices(body, ctx);
      }
    });
  }

  const Shukka = createWizard({
    title: '出荷の記録',
    steps: [
      {
        key: 'productLabel', title: '何を出荷しますか？', hint: '在庫のある製品・バッチだけを表示しています',
        auto: true, autoError: '出荷する製品を選んでください',
        render: function (body, ctx) { renderStockChoices(body, ctx); },
      },
      {
        key: 'suryo', title: '何本出荷しましたか？', hint: '',
        render: function (body, ctx) {
          const it = findStockByLabel(ctx.answers.productLabel);
          const max = it ? availableQty(it) : (ctx.answers.productMax || 0);
          wizardHint.textContent = ctx.answers.productLabel + '／残り ' + max;
          const input = document.createElement('input');
          input.type = 'number'; input.inputMode = 'numeric'; input.min = '1'; input.step = '1';
          input.id = 'input-k-suryo'; input.className = 'text-input text-input--number';
          input.placeholder = '例：12';
          if (ctx.answers.suryo != null) input.value = ctx.answers.suryo;
          body.appendChild(input);
          const unit = document.createElement('p'); unit.className = 'unit-note';
          unit.textContent = '単位：本（缶・樽の数）／残り ' + max;
          body.appendChild(unit);
          const all = document.createElement('button');
          all.type = 'button'; all.className = 'secondary-btn';
          all.textContent = '残り全部（' + max + '）';
          all.addEventListener('click', function () { input.value = String(max); });
          body.appendChild(all);
          setTimeout(function () { input.focus(); }, 50);
        },
        collect: function () { return $('input-k-suryo').value; },
        validate: function (v, ctx) {
          if (v === '' || v == null) return { ok: false, error: '本数を入力してください' };
          const n = Number(v);
          if (!Number.isInteger(n) || n <= 0) return { ok: false, error: '1以上の整数を入力してください' };
          const it = findStockByLabel(ctx.answers.productLabel);
          const max = it ? availableQty(it) : (ctx.answers.productMax || 0);
          // ⚠ 在庫超過は確認で通さない。製品受払簿の在庫がマイナスになる＝台帳の誤りになるため。
          if (n > max) {
            return { ok: false, error: '在庫（' + max + '）を超えています。本数を確認してください' };
          }
          ctx.answers.suryo = n;
          return { ok: true };
        },
      },
      {
        key: 'shukkabi', title: '出荷した日は？', hint: '',
        render: function (body, ctx) {
          const input = document.createElement('input');
          input.type = 'date'; input.id = 'input-k-shukkabi'; input.className = 'text-input';
          input.value = ctx.answers.shukkabi || todayISO();
          body.appendChild(input);
        },
        collect: function () { return $('input-k-shukkabi').value; },
        validate: async function (v, ctx) {
          if (!v) return { ok: false, error: '出荷日を入力してください' };
          if (v > todayISO()) {
            const ok = await confirmModal('未来の日付です（' + v + '）。よろしいですか？');
            if (!ok) return { ok: false, error: null };
          }
          ctx.answers.shukkabi = v;
          return { ok: true };
        },
      },
      {
        key: 'shukkasaki', title: '出荷先は？', hint: '取引先マスターの「出荷先」から選んでください',
        render: function (body, ctx) {
          renderSelectWithOther(body, 'shukkasaki', App.Masters.getShipToCandidates(),
            ctx.answers.shukkasaki || App.Storage.getLastShipTo() || '');
        },
        collect: function () { return collectSelectWithOther('shukkasaki'); },
        validate: function (v, ctx) {
          if (!v) return { ok: false, error: '出荷先を選ぶか、手入力してください' };
          if (v !== ctx.answers.shukkasaki) delete ctx.answers.shukkaKubun; // 先が変われば区分も選び直す
          ctx.answers.shukkasaki = v;
          return { ok: true };
        },
      },
      {
        key: 'shukkaKubun', title: '出荷先区分は？', hint: '酒税の課税区分です。必ず確認してください',
        auto: true, autoError: '出荷先区分を選んでください',
        render: function (body, ctx) {
          // 既定値＝その出荷先で過去いちばん多く使われている区分（製品受払簿の実績から自動）。
          // ⚠ 自動で確定はしない。課税区分なので必ず人が1回押す。
          const recommended = (App.Masters.getActiveStock().kubunByPartner || {})[ctx.answers.shukkasaki] || '';
          const opts = App.MastersSeed.shukkaKubun;
          if (recommended) {
            wizardHint.textContent = '「' + ctx.answers.shukkasaki + '」は、これまで下の✓の区分で出荷されています';
          }
          const wrap = document.createElement('div'); wrap.className = 'choice-list';
          const ordered = recommended
            ? [recommended].concat(opts.filter(function (o) { return o !== recommended; }))
            : opts.slice();
          ordered.forEach(function (o) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'choice-btn choice-btn--list' + (o === recommended ? ' choice-btn--recommended' : '');
            b.textContent = (o === recommended ? '✓ ' : '') + o;
            b.addEventListener('click', function () { ctx.answers.shukkaKubun = o; ctx.goNext(); });
            wrap.appendChild(b);
          });
          body.appendChild(wrap);
        },
      },
      {
        key: 'bikou', title: '備考があれば（任意）', hint: '無ければ空欄のまま「次へ」。事実だけを書いてください（推測や経緯は書かない）',
        render: function (body, ctx) {
          const input = document.createElement('input');
          input.type = 'text'; input.id = 'input-k-bikou'; input.className = 'text-input';
          input.placeholder = '（任意）';
          if (ctx.answers.bikou) input.value = ctx.answers.bikou;
          body.appendChild(input);
        },
        // B-064・§4-3：推定・届出要否・訂正経緯等は書かない（警告のみ・機械的拒否はしない）
        validate: async function (v, ctx) {
          if (v) {
            const hits = App.Send.checkBikoForbidden(v);
            if (hits.length > 0) {
              const ok = await confirmModal(
                '⚠ この備考には次の内容が含まれているようです：\n「' + hits.join('」「') + '」\n\n' +
                '推定・届出要否・訂正の経緯などは備考欄に書かず、事実だけを記録してください。\n' +
                'このまま進めますか？'
              );
              if (!ok) return { ok: false, error: null };
            }
          }
          ctx.answers.bikou = v;
          return { ok: true };
        },
        collect: function () { return $('input-k-bikou').value.trim(); },
      },
      {
        key: 'kirokusha', title: '記録者は？', hint: '',
        render: function (body, ctx) {
          const last = App.Storage.getLastRecorder();
          if (last) {
            const quick = document.createElement('button');
            quick.type = 'button'; quick.className = 'choice-btn'; quick.textContent = '前回と同じ：' + last;
            quick.addEventListener('click', function () { ctx.answers.kirokusha = last; ctx.goNext(); });
            body.appendChild(quick);
          }
          const input = document.createElement('input');
          input.type = 'text'; input.id = 'input-k-kirokusha'; input.className = 'text-input';
          input.value = ctx.answers.kirokusha || last || '';
          body.appendChild(input);
        },
        collect: function () { return $('input-k-kirokusha').value.trim(); },
        validate: function (v, ctx) {
          if (!v) return { ok: false, error: '記録者を入力してください' };
          ctx.answers.kirokusha = v; return { ok: true };
        },
      },
    ],
    confirmRows: function (a) {
      return [
        ['製品・バッチ', a.productLabel],
        ['数量', a.suryo + ' 本'],
        ['出荷日', a.shukkabi],
        ['出荷先', a.shukkasaki],
        ['出荷先区分', a.shukkaKubun],
        ['備考', a.bikou || '（なし）'],
        ['記録者', a.kirokusha],
      ];
    },
    confirmNote: function () {
      return 'ℹ 度数と総量(L)はPonkichiが自動計算します（容器マスターの容量×本数・仕込み帳簿の度数）。' +
        '出荷先区分は酒税の課税区分です。間違えると申告額が変わるので、送信前に見直してください。';
    },
    submit: function (a) { return App.Send.enqueueShukka(a); },
  });

  // ── 確認画面（共通・activeWizardを参照） ──
  function ensureConfirmNoteEl() {
    let el = $('confirm-note');
    if (!el) {
      el = document.createElement('p');
      el.id = 'confirm-note';
      el.className = 'confirm-note';
      const list = $('confirm-list');
      list.parentNode.insertBefore(el, list);
    }
    return el;
  }

  function renderConfirm() {
    const w = activeWizard;
    const a = w.getAnswers();
    const noteEl = ensureConfirmNoteEl();
    const note = w.confirmNote ? w.confirmNote(a) : null;
    if (note) { noteEl.textContent = note; noteEl.hidden = false; }
    else { noteEl.hidden = true; }

    const list = $('confirm-list');
    list.innerHTML = '';
    w.confirmRows(a).forEach(function (pair) {
      const li = document.createElement('li');
      li.innerHTML = '<span class="confirm-label">' + pair[0] + '</span><span class="confirm-value">' + pair[1] + '</span>';
      list.appendChild(li);
    });
  }

  $('btn-confirm-back').addEventListener('click', function () { if (activeWizard) activeWizard.backToLastStep(); });

  $('btn-confirm-send').addEventListener('click', async function () {
    const w = activeWizard;
    const a = w.getAnswers();
    let item;
    try {
      item = w.submit(a);
    } catch (err) {
      showResult(false, '記録できませんでした', String(err && err.message || err));
      return;
    }
    updateQueueBadge();
    showScreen('result');
    $('result-icon').textContent = '⏳';
    $('result-title').textContent = '送信中…';
    $('result-message').textContent = '';

    const res = await App.Send.flushQueue();
    updateQueueBadge();
    // 要件§6-2：着地確認は「アプリ記帳ログ」の読み戻し結果で判定する（fetchの成否では判定しない）
    const q = App.Storage.getQueue().filter(function (x) { return x.uuid === item.uuid; })[0];
    if (!q) {
      showResult(true, '✅ 送信し、台帳に入ったことを確認しました', item.summary);
    } else if (q.held) {
      showResult(false, '⚠ 確認できませんでした', '再送はしていません。Claudeに相談してください（' + item.summary + '）');
    } else if (res && res.offline) {
      showResult(null, '📥 オフラインのため保存しました', item.summary + '（オンライン復帰時に自動で送信します）');
    } else {
      showResult(null, '📨 送信しました', item.summary + '（台帳への反映は次回オンライン時に確認します）');
    }
  });

  function showResult(success, title, message) {
    $('result-icon').textContent = success === true ? '✅' : (success === false ? '❌' : '📥');
    $('result-title').textContent = title;
    $('result-message').textContent = message || '';
  }

  // 単一の「次へ」リスナー → 現在のウィザードへ委譲
  btnNext.addEventListener('click', function () { if (activeWizard) activeWizard._goNext(); });

  $('btn-result-again').addEventListener('click', function () { if (activeWizard) activeWizard.start(); });
  $('btn-result-home').addEventListener('click', function () { showScreen('home'); renderHome(); });

  // ── ホーム画面 ──
  function renderHome() {
    const url = App.Storage.getBridgeUrl();
    const st = App.Send.queueStats ? App.Send.queueStats() : null;
    let msg = url ? '送信先：設定済み' : '⚠ 送信先URLが未設定です（設定画面で入力してください）';
    if (st && st.held > 0) {
      // 要件§6-2：確認できなかった記録は自動再送せず、人間に判断を仰ぐ
      msg = '⚠ 要確認 ' + st.held + '件（台帳に入ったか確認できていません。再送はしていません）';
    } else if (st && st.sent > 0) {
      msg = '📨 反映待ち ' + st.sent + '件（次回オンライン時に確認します）／' + msg;
    }
    $('bridge-status').textContent = msg;
    updateQueueBadge();
  }

  document.querySelector('[data-action="start-nyuka"]').addEventListener('click', function () { Nyuka.start(); });
  document.querySelector('[data-action="start-hakko"]').addEventListener('click', function () { Hakko.start(); });
  document.querySelector('[data-action="start-bt"]').addEventListener('click', function () { BT.start(); });
  document.querySelector('[data-action="start-seihin"]').addEventListener('click', function () { Seihin.start(); });
  document.querySelector('[data-action="start-shukka"]').addEventListener('click', function () { Shukka.start(); });
  $('btn-goto-history').addEventListener('click', function () { showScreen('history'); renderHistory(); });
  $('btn-goto-settings').addEventListener('click', function () { showScreen('settings'); renderSettings(); });

  // ── 設定画面 ──
  function renderSettings() {
    $('input-bridge-url').value = App.Storage.getBridgeUrl();
    $('settings-save-msg').textContent = '';
    renderMastersStatus();
  }

  function renderMastersStatus() {
    function line(label, active) {
      const src = active.source === 'live' ? 'ライブ取得' : '同梱フォールバック';
      const fetchedAt = active.fetchedAt ? new Date(active.fetchedAt).toLocaleString('ja-JP') : '（未取得）';
      return label + '：' + src + '／' + (active.items || []).length + '件／取得日時：' + fetchedAt;
    }
    const partners = App.Masters.getActivePartners();
    const stock = App.Masters.getActiveStock();
    $('masters-status').textContent =
      line('原料マスター', App.Masters.getActive()) + '\n' +
      line('製品マスター', App.Masters.getActiveProducts()) + '\n' +
      line('容器マスター', App.Masters.getActiveContainers()) + '\n' +
      line('出荷先（取引先マスター）', { source: partners.source, items: partners.shipTo, fetchedAt: partners.fetchedAt }) + '\n' +
      '製品在庫：' + (stock.fetchedAt
        ? (stock.items || []).length + '件／取得日時：' + new Date(stock.fetchedAt).toLocaleString('ja-JP')
        : '未取得');
  }

  $('btn-save-url').addEventListener('click', function () {
    const v = $('input-bridge-url').value.trim();
    App.Storage.setBridgeUrl(v);
    $('settings-save-msg').textContent = v ? '保存しました。' : 'URLを空にして保存しました（送信は保留されます）。';
    renderHome();
  });

  $('btn-refresh-masters').addEventListener('click', async function () {
    const url = App.Storage.getBridgeUrl();
    $('masters-refresh-msg').textContent = '取得中…';
    // 原料・製品を個別に判定して、どちらが失敗したか分かる形で出す
    // （まとめて「失敗」と出すと、片方だけ古いまま使われていることに気づけない）
    const results = await Promise.all([
      App.Masters.refresh(url).then(function () { return null; },
        function (e) { return '原料（' + String(e && e.message || e) + '）'; }),
      App.Masters.refreshProducts(url).then(function () { return null; },
        function (e) { return '製品（' + String(e && e.message || e) + '）'; }),
      App.Masters.refreshContainers(url).then(function () { return null; },
        function (e) { return '容器（' + String(e && e.message || e) + '）'; }),
      App.Masters.refreshPartners(url).then(function () { return null; },
        function (e) { return '取引先（' + String(e && e.message || e) + '）'; }),
      App.Masters.refreshStock(url).then(function () { return null; },
        function (e) { return '製品在庫（' + String(e && e.message || e) + '）'; }),
    ]);
    const failed = results.filter(Boolean);
    $('masters-refresh-msg').textContent = failed.length === 0
      ? '取得に成功しました（原料・製品・容器・取引先・製品在庫）。'
      : '取得に失敗：' + failed.join(' / ') + '。失敗した方は同梱データ／前回取得分のまま使用します。';
    renderMastersStatus();
  });

  $('btn-settings-back').addEventListener('click', function () { showScreen('home'); renderHome(); });

  // ── 履歴・キュー画面 ──
  function renderHistory() {
    const queueList = $('queue-list');
    const queue = App.Storage.getQueue();
    queueList.innerHTML = '';
    $('queue-empty-msg').hidden = queue.length > 0;
    queue.forEach(function (item) {
      const li = document.createElement('li');
      li.className = 'list-item';
      const err = item.lastError ? '<br><small class="error-line">' + escapeHtml(item.lastError) + '</small>' : '';
      const badge = item.held ? '⚠ 要確認（再送していません）'
        : (item.status === 'sent' ? '📨 反映待ち' : '📥 未送信');
      li.innerHTML = '<div><b>' + badge + '</b><br>' + escapeHtml(item.summary) +
        '<br><small>試行回数：' + (item.attempts || 0) + '</small>' + err + '</div>';
      const delBtn = document.createElement('button');
      delBtn.type = 'button'; delBtn.className = 'link-btn'; delBtn.textContent = '削除';
      delBtn.addEventListener('click', function () {
        App.Send.removeFromQueue(item.uuid);
        renderHistory();
        updateQueueBadge();
      });
      li.appendChild(delBtn);
      queueList.appendChild(li);
    });

    const historyList = $('history-list');
    historyList.innerHTML = '';
    App.Storage.getHistory().forEach(function (h) {
      const li = document.createElement('li');
      li.className = 'list-item';
      const when = h.sentAt ? new Date(h.sentAt).toLocaleString('ja-JP') : '';
      li.innerHTML = '<div>✅ ' + escapeHtml(h.summary) + '<br><small>' + when + '</small></div>';
      historyList.appendChild(li);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  $('btn-flush-now').addEventListener('click', async function () {
    $('flush-msg').textContent = '送信中…';
    const res = await App.Send.flushQueue();
    updateQueueBadge();
    renderHistory();
    $('flush-msg').textContent = res.sent + '件送信・' + res.remaining + '件残り' + (res.lastError ? '（' + res.lastError + '）' : '');
  });

  $('btn-history-back').addEventListener('click', function () { showScreen('home'); renderHome(); });

  // ── 戻るボタン（画面ごとに文脈で挙動を変える） ──
  btnBack.addEventListener('click', function () {
    if (currentScreen === 'wizard') { if (activeWizard) activeWizard.goBack(); return; }
    if (currentScreen === 'confirm') { if (activeWizard) activeWizard.backToLastStep(); return; }
    showScreen('home'); renderHome();
  });

  // ============================================================
  // 起動処理
  // ============================================================
  function init() {
    showScreen('home');
    renderHome();

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.protocol === 'http:')) {
      navigator.serviceWorker.register('./sw.js').catch(function (err) {
        console.warn('[app] ServiceWorker登録失敗（オフライン起動は無効のまま動作継続）', err);
      });
    }

    if (navigator.onLine !== false) {
      App.Send.flushQueue().then(function () {
        updateQueueBadge();
        if (currentScreen === 'history') renderHistory();
      }).catch(function (err) { console.warn('[app] 起動時の自動再送に失敗', err); });
    }
    window.addEventListener('online', function () {
      App.Send.flushQueue().then(function () {
        updateQueueBadge();
        if (currentScreen === 'history') renderHistory();
      });
    });

    const url = App.Storage.getBridgeUrl();
    if (url) {
      // 原料・製品は別々にcatchする（片方が失敗しても他方のライブ取得を巻き添えにしない）
      App.Masters.refresh(url).catch(function (err) {
        console.warn('[app] 原料マスター背景取得に失敗（同梱データのまま使用）', err);
      });
      App.Masters.refreshProducts(url).catch(function (err) {
        console.warn('[app] 製品マスター背景取得に失敗（同梱データのまま使用）', err);
      });
      App.Masters.refreshContainers(url).catch(function (err) {
        console.warn('[app] 容器マスター背景取得に失敗（同梱データのまま使用）', err);
      });
      App.Masters.refreshPartners(url).catch(function (err) {
        console.warn('[app] 取引先マスター背景取得に失敗（同梱データのまま使用）', err);
      });
      // 製品在庫は出荷画面を開いたときにも取り直す（起動時の値は古くなるため）
      App.Masters.refreshStock(url).catch(function (err) {
        console.warn('[app] 製品在庫の背景取得に失敗（前回取得分のまま使用）', err);
      });
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
