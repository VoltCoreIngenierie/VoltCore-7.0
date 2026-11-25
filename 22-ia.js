/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 22-ia.js
   VERSION : v7.0.7
   RÔLE : Assistant IA (ChatGPT / Claude / DeepSeek).
          Prompts contextuels avec articles + fournisseurs existants.
          Import JSON → facture d'achat. Aperçu avant validation.
   DÉPENDANCES : 00-core, 01-utils, 02-store, 07-suppl, 08-stock, 14-purch
   ORDRE : 23ᵉ fichier chargé

   FIX v7.0.0 :
   - C31 : seuil de similarité UNIQUE à 0.7 (SIMILARITY_THRESHOLD).
     Plus de contradiction entre commentaires et code.
     Politique : matching STRICT sur nom exact OU MF (≥6 chars).
     Alerte "doublon potentiel" si ratio ∈ [0.7, 1).

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - Aucun fuzzy matching qui fusionne deux fournisseurs distincts
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Store || !global.VOLTCORE.Utils) {
    throw new Error('[22-ia] Modules requis non chargés');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store;
  var IA = VC.AssistantIA || {};
  VC.AssistantIA = IA;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — CONSTANTES + ÉTAT
     ═══════════════════════════════════════════════════════════ */

  /**
   * C31 FIX — Seuil UNIQUE de similarité pour l'alerte "doublon potentiel".
   * - ratio >= 0.7 → alerte affichée (informatif, pas de match auto)
   * - ratio < 0.7 → pas d'alerte (noms trop différents)
   *
   * Le seuil n'a AUCUN impact sur le matching automatique :
   *   • Match exact sur nom (normalisé)
   *   • Ou match exact sur MF (≥6 caractères utiles)
   * Toute autre situation = nouveau fournisseur.
   */
  var SIMILARITY_THRESHOLD = 0.7;

  var IA_MODELS = {
    chatgpt:  { label: 'ChatGPT',  url: 'https://chat.openai.com',  icon: '🟢' },
    claude:   { label: 'Claude',   url: 'https://claude.ai',         icon: '🟣' },
    deepseek: { label: 'DeepSeek', url: 'https://chat.deepseek.com', icon: '🔵' }
  };

  var _currentModel = 'chatgpt';
  var _parsedResult = null;
  var _previewMatches = [];
  var _importing = false;
  var _iaPreviewAction = 'purchase';
  var _universalPreview = null;
  var _documentPreview = null;

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — PROMPTS
     ═══════════════════════════════════════════════════════════ */

  var PROMPT_CHATGPT = [
    'RÔLE : Tu es un Ingénieur Électricien Senior, Métreur et Expert-Comptable en Tunisie, avec 20 ans d\'expérience dans le BTP. Tu maîtrises les normes (NFT, IEC), les prix du marché tunisien et le calcul de la TVA (19%) et du Timbre (1.000 DT).',
    '',
    'MISSION : Analyse le document (plan d\'archi, facture, contrat ou texte) que je vais te fournir. Extrais toutes les données pour générer un Devis ou une Facture structurée, prête pour mon logiciel VOLTCORE.',
    '',
    'ÉTAPES DE RÉFLEXION (OBLIGATOIRE) :',
    '1. Analyse spatiale (si plan) : Déduis la surface, le nombre de pièces. Estime les longueurs de câbles (avec 10% de perte), le nombre de prises, interrupteurs et disjoncteurs selon les normes.',
    '2. Extraction (si facture/texte) : Extrais les quantités et prix exacts.',
    '3. Prix : Sépare TOUJOURS la Main d\'œuvre (Service) du Matériel (Fourniture). Si les prix manquent, estime des prix de marché réalistes pour la Tunisie.',
    '4. Vérification : Calcule le Total HT, la TVA (19%), le Timbre (1.000 DT) et le Total TTC. Vérifie tes calculs.',
    '',
    'CONTEXTE VOLTCORE :',
    'Articles existants (matche si possible) :',
    '{ARTICLES_LIST}',
    '',
    'Fournisseurs existants (matche si possible) :',
    '{FOURNISSEURS_LIST}',
    '',
    'SCHÉMA JSON STRICT (Pas de texte avant/après, pas de ```json) :',
    '{"client":{"nom":"Nom","telephone":null,"mf":null,"type":"entreprise"},"chantier":{"nom":"Nom projet","adresse":null},"document":{"type":"devis","sujet":"Description courte","date":"AAAA-MM-JJ","tvaRate":19,"timbre":1.000,"lignes":[{"designation":"Fourniture Câble 3x2.5","quantite":50,"prixUnitaire":1.500,"unite":"m","type":"materiel"},{"designation":"Main d\'œuvre tirage","quantite":5,"prixUnitaire":25.000,"unite":"h","type":"main_oeuvre"}]},"analyse_technique":"Explique ici tes hypothèses de calcul (ex: J\'ai estimé 15 prises car 3 chambres)"}',
    '',
    'Réponds UNIQUEMENT avec le JSON brut.'
  ].join('\n');

  var PROMPT_CLAUDE = [
    'Tu es un Expert Métreur en Électricité BTP (Tunisie).',
    'Ta mission : Analyser le document fourni (plan, facture ou texte) pour générer un Devis/Facture complet.',
    '',
    'INSTRUCTIONS DE RECHERCHE BAS NIVEAU :',
    '- Si c\'est un plan : Fais un métré précis. Estime les câbles, gaines, boîtiers. Justifie tes calculs dans "analyse_technique".',
    '- Si c\'est une facture : Extrais les lignes exactes.',
    '- Sépare impérativement le Matériel (type: "materiel") et la Main d\'œuvre (type: "main_oeuvre").',
    '- Vérifie la cohérence mathématique (HT + 19% TVA + 1 DT Timbre).',
    '',
    'CONTEXTE :',
    '{ARTICLES_LIST}',
    '{FOURNISSEURS_LIST}',
    '',
    'FORMAT DE SORTIE : Retourne UNIQUEMENT un objet JSON valide. Pas de texte.',
    '{"client":{"nom":"...","telephone":null,"mf":null,"type":"..."},"chantier":{"nom":"...","adresse":null},"document":{"type":"devis","sujet":"...","date":"AAAA-MM-JJ","tvaRate":19,"timbre":1,"lignes":[{"designation":"...","quantite":0,"prixUnitaire":0,"unite":"U","type":"materiel|main_oeuvre"}]},"analyse_technique":"..."}'
  ].join('\n');

  var PROMPT_DEEPSEEK = [
    'Agis comme un Ingénieur Métreur en BTP (Tunisie). Analyse le document fourni (plan, facture, texte) et génère un Devis/Facture.',
    'RÈGLES :',
    '1. Fais une recherche bas niveau (ex: si plan, compte les pièces, estime les mètres de câbles nécessaires).',
    '2. Sépare le Matériel (materiel) et la Main d\'œuvre (main_oeuvre).',
    '3. Vérifie les totaux (TVA 19%, Timbre 1 DT).',
    '',
    'Articles dispo : {ARTICLES_LIST}',
    'Fournisseurs dispo : {FOURNISSEURS_LIST}',
    '',
    'Retourne UNIQUEMENT ce JSON brut :',
    '{"client":{"nom":"...","telephone":null,"mf":null,"type":"..."},"chantier":{"nom":"...","adresse":null},"document":{"type":"devis","sujet":"...","date":"AAAA-MM-JJ","tvaRate":19,"timbre":1,"lignes":[{"designation":"...","quantite":0,"prixUnitaire":0,"unite":"U","type":"materiel|main_oeuvre"}]},"analyse_technique":"..."}'
  ].join('\n');

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — HELPERS CONTEXTE
     ═══════════════════════════════════════════════════════════ */

  function _buildArticlesContext() {
    var articles = S.getAll('articles');
    if (articles.length === 0) return '(aucun article dans le stock actuellement)';

    var lines = [];
    var limit = Math.min(100, articles.length);
    for (var i = 0; i < limit; i++) {
      var a = articles[i];
      if (!a || !a.nom) continue;
      var pa = U.parseNumber(a.prixAchat);
      lines.push('- id=' + a.id + ' | nom="' + a.nom + '" | prix_achat=' + pa + ' DT');
    }
    if (lines.length === 0) return '(aucun article nommé)';
    return lines.join('\n');
  }

  function _buildFournisseursContext() {
    var suppliers = S.getAll('suppliers');
    if (suppliers.length === 0) return '(aucun fournisseur enregistré)';

    var lines = [];
    var limit = Math.min(50, suppliers.length);
    for (var i = 0; i < limit; i++) {
      var s = suppliers[i];
      if (!s || !s.nom) continue;
      lines.push('- id=' + s.id + ' | nom="' + s.nom + '"' +
        (s.mf ? ' | mf="' + s.mf + '"' : ''));
    }
    if (lines.length === 0) return '(aucun fournisseur nommé)';
    return lines.join('\n');
  }

  function _buildPromptFor(model) {
    var template = PROMPT_CHATGPT;
    if (model === 'claude') template = PROMPT_CLAUDE;
    else if (model === 'deepseek') template = PROMPT_DEEPSEEK;

    var articlesCtx = _buildArticlesContext();
    var fournisseursCtx = _buildFournisseursContext();

    return template
      .split('{ARTICLES_LIST}').join(articlesCtx)
      .split('{FOURNISSEURS_LIST}').join(fournisseursCtx);
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — UI ACTIONS
     ═══════════════════════════════════════════════════════════ */

  IA.open = function () {
    _currentModel = 'chatgpt';
    IA.switchModel('chatgpt');
    _clearPaste();
    U.setText('iaError', '');
    U.showFlex('iaModal');
  };

  IA.close = function () {
    U.hide('iaModal');
    _currentModel = 'chatgpt';
    _clearPaste();
  };

  IA.switchModel = function (model) {
    var m = String(model || 'chatgpt').toLowerCase();
    if (!IA_MODELS[m]) m = 'chatgpt';
    _currentModel = m;

    var keys = Object.keys(IA_MODELS);
    for (var i = 0; i < keys.length; i++) {
      var btn = document.getElementById('iaModelBtn_' + keys[i]);
      if (btn) {
        if (keys[i] === m) btn.classList.add('active');
        else btn.classList.remove('active');
      }
    }

    _renderPrompt();
  };

  function _renderPrompt() {
    var textarea = document.getElementById('iaPromptDisplay');
    if (!textarea) return;

    var prompt = _buildPromptFor(_currentModel);
    textarea.value = prompt;

    var lbl = document.getElementById('iaModelLabel');
    if (lbl) {
      var info = IA_MODELS[_currentModel];
      lbl.textContent = (info ? info.icon + ' ' + info.label : 'IA');
    }

    var sizeEl = document.getElementById('iaPromptSize');
    if (sizeEl) {
      sizeEl.textContent = prompt.length + ' caractères · ~' +
        Math.round(prompt.length / 4) + ' tokens';
    }
  }

  IA.copyPrompt = function () {
    var textarea = document.getElementById('iaPromptDisplay');
    if (!textarea || !textarea.value) {
      U.toast('Prompt vide.', 'warning');
      return;
    }

    U.copyToClipboard(textarea.value).then(function (ok) {
      if (ok) {
        U.toast('Prompt copié · colle-le dans ' +
          IA_MODELS[_currentModel].label, 'success', 3000);
      } else {
        U.toast('Copie impossible — sélectionne et copie manuellement.',
          'warning', 3500);
      }
    });
  };

  IA.openWebsite = function () {
    var info = IA_MODELS[_currentModel];
    if (!info) return;

    var w = global.open(info.url, '_blank', 'noopener,noreferrer');
    if (!w) {
      U.toast('Pop-up bloqué. Copie cette URL : ' + info.url, 'warning', 5000);
    }
  };

  function _clearPaste() {
    U.setVal('iaPasteTextarea', '');
    U.setText('iaError', '');
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 4.bis — PARSING JSON
     ═══════════════════════════════════════════════════════════ */

  IA.extractJSON = function (text) {
    if (!text) return null;
    try {
      var s = String(text).trim();

      /* Retire les fences markdown éventuelles */
      s = s.replace(/^```(?:json|JSON)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

      /* Cherche la première { et la dernière } */
      var first = s.indexOf('{');
      var last = s.lastIndexOf('}');
      if (first < 0 || last <= first) return null;

      return JSON.parse(s.slice(first, last + 1));
    } catch (e) {
      VC.logError('22-ia', 'extractJSON échoué', e);
      return null;
    }
  };

  IA.parsePastedJSON = function () {
    U.setText('iaError', '');

    var textarea = document.getElementById('iaPasteTextarea');
    var text = textarea ? textarea.value : '';

    if (!text || text.trim().length < 10) {
      U.setText('iaError', 'Colle la réponse JSON de l\'IA dans la zone.');
      return;
    }

    var parsed = IA.extractJSON(text);
    if (!parsed) {
      U.setText('iaError', 'JSON invalide. Vérifie que l\'IA a bien retourné du JSON pur.');
      return;
    }

    var v = IA.validateParsedResult(parsed);
    if (!v.ok) {
      U.setText('iaError', 'Structure invalide : ' + v.error);
      return;
    }

    _parsedResult = v.data;
    IA.openPreview();
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — VALIDATION
     ═══════════════════════════════════════════════════════════ */

  IA.validateParsedResult = function (parsed) {
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'pas un objet JSON' };
    }
    if (!parsed.fournisseur || !String(parsed.fournisseur).trim()) {
      return { ok: false, error: 'fournisseur manquant' };
    }
    if (!Array.isArray(parsed.lignes) || parsed.lignes.length === 0) {
      return { ok: false, error: 'aucune ligne' };
    }

    var warnings = [];
    var cleanLines = [];
    for (var i = 0; i < parsed.lignes.length; i++) {
      var l = parsed.lignes[i];
      if (!l || typeof l !== 'object') continue;

      var designation = String(l.designation || '').trim();
      if (!designation) continue;

      var q = U.parseNumber(l.quantite);
      var p = U.parseNumber(l.prixUnitaire);
      if (q <= 0) warnings.push('Ligne ' + (i + 1) + ' : quantité <= 0 (' + q + ').');
      if (p < 0) warnings.push('Ligne ' + (i + 1) + ' : prix négatif (' + U.formatMoney(p) + ').');
      if (p > VC.MAX_DOC_PU) warnings.push('Ligne ' + (i + 1) + ' : prix suspect (' + U.formatMoney(p) + ').');
      if (q <= 0 || p < 0) continue;

      cleanLines.push({
        articleId: String(l.articleId || ''),
        designation: designation,
        quantite: q,
        prixUnitaire: p,
        unite: String(l.unite || 'U')
      });
    }

    if (cleanLines.length === 0) {
      return { ok: false, error: 'aucune ligne valide' };
    }

    var dateStr = String(parsed.date || '').slice(0, 10);
    var validDate = U.isValidDateString(dateStr) ? dateStr : U.todayISO();
    if (!U.isValidDateString(dateStr)) {
      warnings.push('Date invalide ou absente : "' + dateStr + '". Date locale utilisée.');
    }

    var tvaRate = U.parseNumber(parsed.tvaRate);
    if (!isFinite(tvaRate) || tvaRate < 0) {
      warnings.push('TVA invalide : valeur remise à ' + VC.TVA_DEFAULT + '%.');
      tvaRate = VC.TVA_DEFAULT;
    } else if (tvaRate > 100) {
      warnings.push('TVA supérieure à 100% : valeur ramenée à 100%.');
      tvaRate = 100;
    }

    var timbre = U.parseNumber(parsed.timbre);
    if (!isFinite(timbre) || timbre < 0) {
      warnings.push('Timbre invalide : valeur remise à 0 DT.');
      timbre = 0;
    }

    return {
      ok: true,
      data: {
        fournisseur: String(parsed.fournisseur).trim(),
        fournisseurMF: String(parsed.fournisseurMF || '').trim(),
        numeroFacture: String(parsed.numeroFacture || '').trim(),
        date: validDate,
        tvaRate: tvaRate,
        timbre: timbre,
        lignes: cleanLines,
        warnings: warnings,
        analyseTechnique: String(parsed.analyse_technique || '').trim(),
        hypotheses: Array.isArray(parsed.hypotheses)
          ? parsed.hypotheses.map(function (h) { return String(h || '').trim(); }).filter(function (h) { return !!h; })
          : [],
        confiance: parsed.confiance == null
          ? 50
          : U.clamp(U.parseNumber(parsed.confiance), 0, 100)
      }
    };
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — MATCHING (C31 FIX)
     ═══════════════════════════════════════════════════════════ */

  /**
   * Similarité entre deux noms (0-1).
   * - 1.0 si identiques (après normalisation)
   * - Si l'un est préfixe de l'autre : ratio = longueur_court / longueur_long
   *   (ex: "AFEL" ⊂ "AFEL ELECTRICITE" → 4/15 ≈ 0.27)
   * - 0 sinon
   *
   * Utilisé UNIQUEMENT pour l'alerte "doublon potentiel".
   * Le seuil SIMILARITY_THRESHOLD (0.7) décide si l'alerte est affichée.
   */
  function _nameSimilarity(a, b) {
    if (!a || !b) return 0;
    var na = U.normalizeText(a);
    var nb = U.normalizeText(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;

    var la = na.length, lb = nb.length;
    var shorter = Math.min(la, lb);
    var longer = Math.max(la, lb);
    if (shorter === 0) return 0;

    /* Inclusion en préfixe → ratio proportionnel */
    if (na.indexOf(nb) === 0 || nb.indexOf(na) === 0) {
      return shorter / longer;
    }
    return 0;
  }

  /**
   * Trouve les fournisseurs proches (ratio >= SIMILARITY_THRESHOLD).
   * Purement informatif : sert à afficher une alerte dans l'aperçu.
   * Ne déclenche AUCUN match automatique.
   */
  function _findSimilarSuppliers(name, excludeId) {
    var out = [];
    if (!name) return out;
    var suppliers = S.getAll('suppliers');

    for (var i = 0; i < suppliers.length; i++) {
      var s = suppliers[i];
      if (!s || !s.nom) continue;
      if (excludeId && String(s.id) === String(excludeId)) continue;

      var ratio = _nameSimilarity(name, s.nom);
      if (ratio >= SIMILARITY_THRESHOLD && ratio < 1) {
        out.push({ id: s.id, nom: s.nom, ratio: ratio });
      }
    }

    out.sort(function (a, b) { return b.ratio - a.ratio; });
    return out;
  }

  /**
   * Match fournisseur — politique STRICTE :
   *   1. Match EXACT sur nom normalisé → fournisseur existant
   *   2. Match EXACT sur MF (≥6 chars utiles) → fournisseur existant
   *   3. Sinon → nouveau fournisseur + alerte si similaires >= 0.7
   *
   * Aucun fuzzy matching d'inclusion (n'associe JAMAIS
   * "AFEL" à "AFELEC" ou "STEG" à "STEG INDUSTRIE").
   */
    /**
   * FIX R-NEW : trouve les articles similaires (ratio >= SIMILARITY_THRESHOLD).
   * Purement informatif : sert à afficher une alerte dans l'aperçu.
   * Ne déclenche AUCUN match automatique.
   */
  function _findSimilarArticles(designation, excludeId) {
    var out = [];
    if (!designation) return out;
    var articles = S.getAll('articles');

    for (var i = 0; i < articles.length; i++) {
      var a = articles[i];
      if (!a || !a.nom) continue;
      if (excludeId && String(a.id) === String(excludeId)) continue;

      var ratio = _nameSimilarity(designation, a.nom);
      if (ratio >= SIMILARITY_THRESHOLD && ratio < 1) {
        out.push({ id: a.id, nom: a.nom, ratio: ratio });
      }
    }

    out.sort(function (a, b) { return b.ratio - a.ratio; });
    return out;
  }
  function _matchSupplier(name, mf) {
    var result = {
      id: null,
      name: String(name || ''),
      isNew: true,
      mf: String(mf || ''),
      similarSuppliers: []
    };

    if (!name) return result;

    var suppliers = S.getAll('suppliers');
    var normalized = U.normalizeText(name);
    var mfNormalized = String(mf || '').replace(/\s/g, '').toUpperCase();

    /* 1. Match exact sur nom */
    for (var i = 0; i < suppliers.length; i++) {
      if (U.normalizeText(suppliers[i].nom || '') === normalized) {
        return {
          id: suppliers[i].id,
          name: suppliers[i].nom,
          isNew: false,
          mf: suppliers[i].mf || '',
          similarSuppliers: []
        };
      }
    }

    /* 2. Match exact sur MF (≥6 chars) */
    if (mfNormalized && mfNormalized.length >= 6) {
      for (var j = 0; j < suppliers.length; j++) {
        var sMf = String(suppliers[j].mf || '').replace(/\s/g, '').toUpperCase();
        if (sMf && sMf === mfNormalized) {
          return {
            id: suppliers[j].id,
            name: suppliers[j].nom,
            isNew: false,
            mf: suppliers[j].mf || '',
            similarSuppliers: []
          };
        }
      }
    }

    /* 3. Nouveau + similaires (informatif) */
    result.similarSuppliers = _findSimilarSuppliers(name, null);
    return result;
  }

  /**
   * Match article — politique STRICTE :
   *   1. Match EXACT sur articleId fourni par l'IA
   *   2. Match EXACT sur nom normalisé
   *   3. Sinon → nouveau
   */
  function _matchArticle(designation, aiArticleId) {
    var result = {
      id: null,
      nom: String(designation || ''),
      isMatch: false,
      similarArticles: []
    };

    if (aiArticleId && VC.Stock && typeof VC.Stock.getById === 'function') {
      var art = VC.Stock.getById(aiArticleId);
      if (art) {
        return {
          id: art.id,
          nom: VC.Stock.getNom(art),
          isMatch: true,
          source: 'ai-id',
          similarArticles: []
        };
      }
    }

    var articles = S.getAll('articles');
    var normalized = U.normalizeText(designation);

    for (var i = 0; i < articles.length; i++) {
      if (U.normalizeText(articles[i].nom || '') === normalized) {
        return {
          id: articles[i].id,
          nom: articles[i].nom,
          isMatch: true,
          source: 'name',
          similarArticles: []
        };
      }
    }

    // FIX R-NEW : pas de match exact → chercher les similaires (informatif)
    result.similarArticles = _findSimilarArticles(designation, null);
    return result;
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — APERÇU
     ═══════════════════════════════════════════════════════════ */

  IA.openPreview = function () {
    if (!_parsedResult) return;
    _iaPreviewAction = 'purchase';
    _computePreviewMatches();
    _renderPreview();
    U.showFlex('iaPreviewModal');
  };

  IA.closePreview = function () {
    U.hide('iaPreviewModal');
    _parsedResult = null;
    _previewMatches = [];
    _universalPreview = null;
    _documentPreview = null;
    _iaPreviewAction = 'purchase';
  };

  function _computePreviewMatches() {
    _previewMatches = [];
    if (!_parsedResult) return;

    var supplier = _matchSupplier(
      _parsedResult.fournisseur,
      _parsedResult.fournisseurMF
    );

    for (var i = 0; i < _parsedResult.lignes.length; i++) {
      var l = _parsedResult.lignes[i];
      var match = _matchArticle(l.designation, l.articleId);
      _previewMatches.push({
        lineIndex: i,
        supplier: supplier,
        article: match,
        line: l
      });
    }
  }

  function _renderPreview() {
    var body = document.getElementById('iaPreviewBody');
    if (!body || !_parsedResult) return;

    var d = _parsedResult;
    var supplier = _matchSupplier(d.fournisseur, d.fournisseurMF);

    var totals = VC.Purchases
      ? VC.Purchases.computeTotals(d.lignes, d.tvaRate, d.timbre)
      : { totalHT: 0, tva: 0, totalTTC: 0 };

    var html = '';

    /* Fournisseur */
    html += '<div class="ia-preview-block"><h4>Fournisseur</h4>';
    if (supplier.isNew) {
      html += '<div><span class="badge badge-warning">⚠ Nouveau</span> ' +
        U.escapeHtml(supplier.name) +
        ' — sera créé automatiquement';
      if (supplier.mf) {
        html += ' <span class="muted">(MF : ' +
          U.escapeHtml(supplier.mf) + ')</span>';
      }
      html += '</div>';

      /* Alerte doublon potentiel (seuil 0.7) */
      if (supplier.similarSuppliers.length > 0) {
        html += '<div style="margin-top:8px;padding:8px;background:#fff7ed;' +
          'border-left:3px solid #d97706;border-radius:4px;font-size:12px">';
        html += '<strong>⚠ Doublon potentiel détecté :</strong><br>';
        for (var ss = 0; ss < Math.min(3, supplier.similarSuppliers.length); ss++) {
          var sim = supplier.similarSuppliers[ss];
          html += '• "' + U.escapeHtml(sim.nom) + '" (' +
            Math.round(sim.ratio * 100) + '% similaire)<br>';
        }
        html += '<span class="muted" style="font-size:11px">' +
          'Si c\'est le même fournisseur, annule et crée-le manuellement.</span>';
        html += '</div>';
      }
    } else {
      html += '<div><span class="badge badge-success">✓ Existant</span> ' +
        U.escapeHtml(supplier.name) + '</div>';
    }
    html += '</div>';

    /* Facture */
    html += '<div class="ia-preview-block"><h4>Facture</h4>';
    html += '<div><strong>N°</strong> ' +
      U.escapeHtml(d.numeroFacture || '(auto)') + '</div>';
    html += '<div><strong>Date</strong> ' +
      U.escapeHtml(U.formatDate(d.date)) + '</div>';
    html += '<div><strong>TVA</strong> ' + d.tvaRate + '% · ' +
      '<strong>Timbre</strong> ' + U.formatMoney(d.timbre) + '</div>';
    html += '</div>';

    /* Lignes */
    var matchedCount = 0, newCount = 0;
    for (var i = 0; i < _previewMatches.length; i++) {
      if (_previewMatches[i].article.isMatch) matchedCount++;
      else newCount++;
    }

    html += '<div class="ia-preview-block"><h4>Lignes (' +
      d.lignes.length + ' — ' + matchedCount + ' reconnu(s), ' +
      newCount + ' nouveau(x))</h4>';
    html += '<table class="ia-preview-table"><thead><tr>' +
      '<th>Désignation</th><th>Article</th><th class="right">Qté</th>' +
      '<th class="right">P.U.</th><th class="right">Total</th>' +
      '</tr></thead><tbody>';

    for (var j = 0; j < d.lignes.length; j++) {
      var l = d.lignes[j];
      var match = _previewMatches[j]
        ? _previewMatches[j].article
        : { isMatch: false, similarArticles: [] };
      var artCell;
      if (match.isMatch) {
        artCell = '<span class="badge badge-success">✓</span> ' +
          U.escapeHtml(match.nom || '');
      } else if (match.similarArticles && match.similarArticles.length > 0) {
        // FIX R-NEW : alerte doublon potentiel sur les articles
        var sim = match.similarArticles[0];
        artCell = '<span class="badge badge-warning">⚠</span> ' +
          '<span class="muted">nouveau</span>' +
          '<div style="font-size:10px;color:#d97706;margin-top:2px">' +
          'Similaire à "' + U.escapeHtml(sim.nom) + '" (' +
          Math.round(sim.ratio * 100) + '%)</div>';
      } else {
        artCell = '<span class="badge badge-warning">⚠</span> ' +
          '<span class="muted">nouveau</span>';
      }
      var lt = U.parseNumber(l.quantite) * U.parseNumber(l.prixUnitaire);
      html += '<tr>' +
        '<td>' + U.escapeHtml(l.designation) + '</td>' +
        '<td>' + artCell + '</td>' +
        '<td class="right">' + l.quantite + ' ' + U.escapeHtml(l.unite) + '</td>' +
        '<td class="right">' + U.formatMoney(l.prixUnitaire) + '</td>' +
        '<td class="right">' + U.formatMoney(lt) + '</td>' +
        '</tr>';
    }
    html += '</tbody></table>';

    if (newCount > 0) {
      html += '<div class="ia-preview-option">' +
        '<label><input type="checkbox" id="iaAutoCreateArticles" checked> ' +
        'Créer automatiquement les ' + newCount + ' article(s) manquant(s)' +
        '</label></div>';
      // FIX R-NEW : avertir sur le prix de vente par défaut
      html += '<div style="margin-top:8px;padding:8px 10px;background:#fef3c7;' +
        'border-left:3px solid #d97706;border-radius:4px;font-size:11px">' +
        '<strong>Prix de vente proposé :</strong> marge actuelle ' +
        '<input id="iaSaleMargin" type="number" min="-100" max="1000" value="30" style="width:80px" aria-label="Marge de vente en pourcentage"> %' +
        ' sur le prix d\'achat. Cette marge reste modifiable avant confirmation.</div>';
    }
    html += '</div>';

    if (d.warnings && d.warnings.length > 0) {
      html += '<div class="ia-preview-block"><h4>⚠ Anomalies détectées</h4>';
      html += '<ul style="margin:6px 0;padding-left:18px">';
      for (var wi = 0; wi < d.warnings.length; wi++) {
        html += '<li>' + U.escapeHtml(d.warnings[wi]) + '</li>';
      }
      html += '</ul></div>';
    }

    if (d.analyseTechnique || d.hypotheses.length > 0) {
      html += '<div class="ia-preview-block"><h4>Hypothèses IA · confiance ' + d.confiance + '%</h4>';
      if (d.analyseTechnique) html += '<p>' + U.escapeHtml(d.analyseTechnique) + '</p>';
      if (d.hypotheses.length > 0) {
        html += '<ul style="margin:6px 0;padding-left:18px">';
        for (var hi = 0; hi < d.hypotheses.length; hi++) {
          html += '<li>' + U.escapeHtml(d.hypotheses[hi]) + '</li>';
        }
        html += '</ul>';
      }
      html += '</div>';
    }

    /* Totaux */
    html += '<div class="ia-preview-block"><h4>Totaux recalculés</h4>';
    html += '<div><strong>Total HT</strong> : ' +
      U.formatMoney(totals.totalHT) + '</div>';
    html += '<div><strong>TVA (' + d.tvaRate + '%)</strong> : ' +
      U.formatMoney(totals.tva) + '</div>';
    html += '<div><strong>Timbre</strong> : ' +
      U.formatMoney(d.timbre) + '</div>';
    html += '<div class="ia-preview-total"><strong>TOTAL TTC</strong> : ' +
      U.formatMoney(totals.totalTTC) + '</div>';
    html += '</div>';

    body.innerHTML = html;
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — IMPORT
     ═══════════════════════════════════════════════════════════ */

  function _createSupplierQuick(nom, mf) {
    return S.save('suppliers', {
      nom: String(nom || '').trim(),
      mf: String(mf || '').trim(),
      notes: 'Créé automatiquement par import IA'
    });
  }

  function _createArticleQuick(designation, prixUnitaire, marginPct) {
    var nom = String(designation || '').trim();
    if (!nom) return null;

    // FIX R-NEW : prix de vente par défaut = prixAchat × 1.30 (marge 30%)
    // Avant : prix = 0 → marge -100% → alerte dashboard + vente à 0 DT
    // Après : Anis peut ajuster dans Stock, mais l'article est cohérent
    var pa = U.parseNumber(prixUnitaire);
    var margin = U.parseNumber(marginPct);
    if (!isFinite(margin)) margin = 30;
    margin = U.clamp(margin, -100, 1000);
    var pv = pa > 0 ? Math.round(pa * (1 + margin / 100) * 1000) / 1000 : 0;

    return S.save('articles', {
      nom: nom,
      designation: nom,
      prix: pv,
      prixAchat: pa,
      stock: 0,
      seuil: 0,
      unite: 'U',
      famille: '',
      codeBarre: '',
      hs: false,
      actif: true,
      notes: 'Créé automatiquement par import IA (marge vente = ' + margin + '% — à vérifier)'
    });
  }

  IA.confirmImport = function () {
    if (_importing) return;
    _importing = true;

    try {
      if (_iaPreviewAction === 'universal') {
        _importing = false;
        return IA.confirmUniversalPreview();
      }
      if (_iaPreviewAction === 'document') {
        _importing = false;
        return IA.confirmDocumentPreview();
      }
      if (!_parsedResult) {
        U.toast('Aucun aperçu à confirmer.', 'error');
        return;
      }

      var d = _parsedResult;
      if (d.warnings && d.warnings.length > 0) {
        if (!VC.Auth || !VC.Auth.confirmAdminException ||
            !VC.Auth.confirmAdminException(d.warnings.join('\n'))) {
          U.toast('Import annulé après anomalie détectée.', 'warning', 4000);
          return;
        }
      }

      /* 1. Fournisseur */
      var supMatch = _matchSupplier(d.fournisseur, d.fournisseurMF);
      var supplierId, supplierName;

      if (supMatch.isNew) {
        var newSup = _createSupplierQuick(supMatch.name, supMatch.mf);
        if (!newSup) {
          throw new Error('Création fournisseur échouée');
        }
        supplierId = newSup.id;
        supplierName = newSup.nom;
      } else {
        supplierId = supMatch.id;
        supplierName = supMatch.name;
      }

      /* 2. Lignes */
      var autoCreate = true;
      var cb = document.getElementById('iaAutoCreateArticles');
      if (cb) autoCreate = !!cb.checked;

      var marginInput = document.getElementById('iaSaleMargin');
      var marginPct = marginInput ? U.parseNumber(marginInput.value) : 30;
      marginPct = U.clamp(marginPct, -100, 1000);

      var finalLines = [];
      for (var i = 0; i < d.lignes.length; i++) {
        var l = d.lignes[i];
        var match = _matchArticle(l.designation, l.articleId);
        var articleId = match.id || '';
        var designation = match.isMatch ? match.nom : l.designation;

        if (!articleId && autoCreate) {
          var newArt = _createArticleQuick(designation, l.prixUnitaire, marginPct);
          if (newArt) {
            articleId = newArt.id;
            designation = newArt.nom;
          }
        }

        finalLines.push({
          articleId: articleId,
          designation: designation,
          quantite: l.quantite,
          prixUnitaire: l.prixUnitaire,
          unite: l.unite,
          total: l.quantite * l.prixUnitaire
        });
      }

      /* 3. Totaux */
      var totals = VC.Purchases
        ? VC.Purchases.computeTotals(finalLines, d.tvaRate, d.timbre)
        : { totalHT: 0, tvaRate: d.tvaRate, tva: 0, timbre: d.timbre,
            totalTTC: 0, total: 0 };

      /* 4. Facture d'achat avec numéro réservé */
      var reservePromise = d.numeroFacture
        ? Promise.resolve(d.numeroFacture)
        : (S.reserveNumero
            ? S.reserveNumero('achat')
            : Promise.resolve('ACH-' + new Date().getFullYear() + '-' +
                String(S.getAll('purchaseInvoices').length + 1).padStart(4, '0')));

      return reservePromise.then(function (docNumero) {
        var doc = {
          numero: docNumero,
          refFacture: d.numeroFacture || docNumero,
          supplierId: supplierId,
          fournisseurId: supplierId,
          fournisseur: supplierName,
          date: d.date,
          chantierId: '',
          tvaRate: totals.tvaRate,
          timbre: totals.timbre,
          notes: 'Importé via Assistant IA le ' + U.todayISO(),
          lines: finalLines,
          totals: totals,
          totalTTC: totals.totalTTC,
          total: totals.totalTTC,
          paiements: [],
          source: 'ia'
        };

        if (!S.save('purchaseInvoices', doc)) {
          throw new Error('Enregistrement facture échoué');
        }

        /* 5. Alimente comparateur de prix */
        if (VC.Stock && typeof VC.Stock.recordExternalPrice === 'function') {
          for (var k = 0; k < finalLines.length; k++) {
            var fl = finalLines[k];
            if (fl.articleId && fl.prixUnitaire > 0) {
              try {
                VC.Stock.recordExternalPrice(
                  fl.articleId, fl.prixUnitaire, supplierName,
                  doc.numero, d.date
                );
              } catch (e) {
                VC.logError('22-ia', 'recordExternalPrice échoué', e);
              }
            }
          }
        }

        IA.closePreview();
        IA.close();
        U.toast('Import réussi : ' + docNumero + ' · ' +
          finalLines.length + ' ligne(s)', 'success', 4000);
        _importing = false;
        return true;
      }).catch(function (e) {
        VC.logError('22-ia', 'confirmImport achat échoué', e);
        U.toast('Erreur d\'import : ' + (e.message || ''), 'error', 5000);
        _importing = false;
        return false;
      });

    } catch (e) {
      VC.logError('22-ia', 'confirmImport échoué', e);
      U.toast('Erreur d\'import : ' + (e.message || ''), 'error', 5000);
    } finally {
      _importing = false;
    }
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 9 — EVENTS
     ═══════════════════════════════════════════════════════════ */
  /**
   * FIX BLOC C : Importation universelle (Clients, Fournisseurs, Articles)
   */
  function _normalizeUniversalPreview(parsed) {
    var out = { clients: [], suppliers: [], articles: [], chantiers: [], warnings: [] };
    var collections = [
      ['clients', 'clients'],
      ['fournisseurs', 'suppliers'],
      ['articles', 'articles'],
      ['chantiers', 'chantiers']
    ];

    for (var c = 0; c < collections.length; c++) {
      var key = collections[c][0];
      var storeName = collections[c][1];
      var source = parsed[key];
      if (!Array.isArray(source)) continue;

      for (var i = 0; i < source.length; i++) {
        var raw = source[i];
        if (!raw || typeof raw !== 'object') continue;
        var name = String(raw.nom || '').trim();
        if (!name) {
          out.warnings.push(key + ' ligne ' + (i + 1) + ' : nom vide ignoré.');
          continue;
        }

        var item = S.normalize(storeName, raw);
        if (!item) {
          out.warnings.push(key + ' ligne ' + (i + 1) + ' : données invalides ignorées.');
          continue;
        }
        if (storeName === 'articles') {
          var type = String(raw.type || '').toLowerCase();
          if (type === 'main_oeuvre' || type === 'service') item.hs = true;
        }
        out[key === 'fournisseurs' ? 'suppliers' : key].push(item);
      }
    }

    return out;
  }

  function _showUniversalPreview(parsed) {
    var preview = _normalizeUniversalPreview(parsed);
    if (!preview.clients.length && !preview.suppliers.length &&
        !preview.articles.length && !preview.chantiers.length) {
      U.toast('Aucune donnée valide à importer.', 'error', 4000);
      return false;
    }

    _universalPreview = preview;
    _iaPreviewAction = 'universal';

    var html = '<div class="ia-preview-block"><h4>Import universel IA</h4>';
    html += '<div>Clients : <strong>' + preview.clients.length + '</strong></div>';
    html += '<div>Fournisseurs : <strong>' + preview.suppliers.length + '</strong></div>';
    html += '<div>Articles : <strong>' + preview.articles.length + '</strong></div>';
    html += '<div>Chantiers : <strong>' + preview.chantiers.length + '</strong></div>';
    html += '</div>';

    if (preview.warnings.length > 0) {
      html += '<div class="ia-preview-block"><h4>⚠ Éléments ignorés</h4><ul style="margin:6px 0;padding-left:18px">';
      for (var i = 0; i < preview.warnings.length; i++) {
        html += '<li>' + U.escapeHtml(preview.warnings[i]) + '</li>';
      }
      html += '</ul></div>';
    }

    html += '<div class="ia-preview-block"><p class="muted">Les lignes sont validées et normalisées. Toute écriture reste soumise à confirmation.</p></div>';
    document.getElementById('iaPreviewBody').innerHTML = html;
    U.showFlex('iaPreviewModal');
    return true;
  }

  IA.normalizeUniversalPreview = _normalizeUniversalPreview;

  IA.confirmUniversalPreview = function () {
    if (!VC.Auth || !VC.Auth.isAdmin()) {
      U.toast('Import universel réservé aux administrateurs.', 'warning', 4000);
      return false;
    }
    if (!_universalPreview) return false;

    var preview = _universalPreview;
    var count = { clients: 0, suppliers: 0, articles: 0, chantiers: 0 };

    for (var i = 0; i < preview.clients.length; i++) {
      if (S.save('clients', preview.clients[i])) count.clients++;
    }
    for (var j = 0; j < preview.suppliers.length; j++) {
      if (S.save('suppliers', preview.suppliers[j])) count.suppliers++;
    }
    for (var k = 0; k < preview.articles.length; k++) {
      if (S.save('articles', preview.articles[k])) count.articles++;
    }
    for (var l = 0; l < preview.chantiers.length; l++) {
      if (S.save('chantiers', preview.chantiers[l])) count.chantiers++;
    }

    IA.closePreview();
    IA.close();
    U.toast('Import terminé : ' + count.clients + ' client(s), ' +
      count.suppliers + ' fournisseur(s), ' + count.articles + ' article(s), ' +
      count.chantiers + ' chantier(s).', 'success', 5000);
    if (typeof VC.refreshAllUI === 'function') VC.refreshAllUI();
    return true;
  };

  IA.importUniversalData = function () {
    var textarea = document.getElementById('iaPasteTextarea');
    var text = textarea ? textarea.value : '';

    if (!text || text.trim().length < 10) {
      U.toast('Colle le JSON de l\'IA dans la zone de texte.', 'warning');
      return;
    }

    var parsed = IA.extractJSON(text);
    if (!parsed) {
      U.toast('JSON invalide.', 'error');
      return;
    }

    _showUniversalPreview(parsed);
  };
    /**
   * FIX BLOC C : Bouton Magique
   * Transforme le JSON de l'IA en un formulaire de Devis/Facture pré-rempli.
   */
  IA.generateDocumentFromJSON = function () {
    var textarea = document.getElementById('iaPasteTextarea');
    var text = textarea ? textarea.value : '';

    if (!text || text.trim().length < 10) {
      U.toast('Colle le JSON de l\'IA dans la zone de texte.', 'warning');
      return;
    }

    var parsed = IA.extractJSON(text);
    if (!parsed || !parsed.document || !Array.isArray(parsed.document.lignes)) {
      U.toast('Structure JSON invalide (il manque le bloc "document" ou "lignes").', 'error');
      return;
    }

    var warnings = [];
    var lines = [];
    for (var i = 0; i < parsed.document.lignes.length; i++) {
      var l = parsed.document.lignes[i] || {};
      var designation = String(l.designation || '').trim();
      var quantite = U.parseNumber(l.quantite);
      var prix = U.parseNumber(l.prixUnitaire);
      if (!designation) warnings.push('Ligne ' + (i + 1) + ' : désignation vide.');
      if (quantite <= 0) warnings.push('Ligne ' + (i + 1) + ' : quantité <= 0.');
      if (prix < 0) warnings.push('Ligne ' + (i + 1) + ' : prix négatif.');
      if (designation && quantite > 0 && prix >= 0) {
        lines.push({
          designation: designation,
          quantite: quantite,
          prixUnitaire: prix,
          unite: String(l.unite || 'U'),
          type: String(l.type || 'materiel'),
          prixAchat: U.parseNumber(l.prixAchat)
        });
      }
    }

    if (lines.length === 0) {
      U.toast('Aucune ligne de document valide.', 'error', 4000);
      return;
    }

    _documentPreview = {
      parsed: parsed,
      lines: lines,
      warnings: warnings
    };
    _iaPreviewAction = 'document';

    var html = '<div class="ia-preview-block"><h4>Préparation du document IA</h4>';
    html += '<div><strong>Type :</strong> ' + U.escapeHtml(parsed.document.type || 'devis') + '</div>';
    html += '<div><strong>Client :</strong> ' + U.escapeHtml(parsed.client && parsed.client.nom ? parsed.client.nom : '(non renseigné)') + '</div>';
    html += '<div><strong>Chantier :</strong> ' + U.escapeHtml(parsed.chantier && parsed.chantier.nom ? parsed.chantier.nom : '(non renseigné)') + '</div>';
    html += '<div><strong>Sujet :</strong> ' + U.escapeHtml(parsed.document.sujet || '') + '</div>';
    html += '<div><strong>Lignes :</strong> ' + lines.length + '</div>';
    html += '</div>';

    if (warnings.length > 0) {
      html += '<div class="ia-preview-block"><h4>⚠ Anomalies détectées</h4><ul style="margin:6px 0;padding-left:18px">';
      for (var wi = 0; wi < warnings.length; wi++) html += '<li>' + U.escapeHtml(warnings[wi]) + '</li>';
      html += '</ul></div>';
    }

    if (parsed.document.analyse_technique) {
      html += '<div class="ia-preview-block"><h4>Hypothèses IA</h4>' +
        '<p>' + U.escapeHtml(parsed.document.analyse_technique) + '</p></div>';
    }

    html += '<div class="ia-preview-block"><p class="muted">Après confirmation, les références nécessaires seront créées puis le formulaire sera pré-rempli. Rien n’est enregistré comme document comptable avant ta confirmation finale dans le formulaire.</p></div>';
    document.getElementById('iaPreviewBody').innerHTML = html;
    U.showFlex('iaPreviewModal');
  };

  IA.confirmDocumentPreview = function () {
    if (!_documentPreview) return false;
    if (!VC.Auth || !VC.Auth.isAdmin()) {
      U.toast('Préparation réservée aux administrateurs.', 'warning', 4000);
      return false;
    }

    var preview = _documentPreview;
    var parsed = preview.parsed;
    if (preview.warnings.length > 0 &&
        (!VC.Auth.confirmAdminException ||
         !VC.Auth.confirmAdminException(preview.warnings.join('\n')))) {
      U.toast('Préparation annulée après anomalie détectée.', 'warning', 4000);
      return false;
    }

    var clientId = '';
    var chantierId = '';

    if (parsed.client && parsed.client.nom) {
      var existingClient = VC.Clients && VC.Clients.exists(parsed.client.nom)
        ? VC.Clients.getFiltered().find(function (c) { return String(c.nom || '').toLowerCase() === String(parsed.client.nom).toLowerCase(); })
        : null;
      if (existingClient) {
        clientId = existingClient.id;
      } else {
        var newClient = VC.Store.save('clients', {
          nom: parsed.client.nom,
          telephone: parsed.client.telephone || '',
          mf: parsed.client.mf || '',
          type: parsed.client.type || 'entreprise',
          notes: 'Créé par l\'IA après confirmation'
        });
        if (newClient) clientId = newClient.id;
      }
    }

    if (parsed.chantier && parsed.chantier.nom) {
      var existingChantier = VC.Chantiers && VC.Chantiers.exists(parsed.chantier.nom)
        ? VC.Chantiers.getFiltered().find(function (c) { return String(c.nom || '').toLowerCase() === String(parsed.chantier.nom).toLowerCase(); })
        : null;
      if (existingChantier) {
        chantierId = existingChantier.id;
      } else {
        var newChantier = VC.Store.save('chantiers', {
          nom: parsed.chantier.nom,
          adresse: parsed.chantier.adresse || '',
          clientId: clientId,
          statut: 'en_cours',
          notes: 'Créé par l\'IA après confirmation'
        });
        if (newChantier) chantierId = newChantier.id;
      }
    }

    var finalItems = [];
    for (var i = 0; i < preview.lines.length; i++) {
      var l = preview.lines[i];
      var existingArt = VC.Stock && typeof VC.Stock.getFiltered === 'function'
        ? VC.Stock.getFiltered().find(function (a) {
            return String(a.nom || '').toLowerCase() === String(l.designation).toLowerCase();
          })
        : null;
      var artId = existingArt ? existingArt.id : '';

      if (!artId) {
        var isService = l.type === 'main_oeuvre' || l.type === 'service';
        var newArt = VC.Store.save('articles', {
          nom: l.designation,
          designation: l.designation,
          prix: l.prixUnitaire,
          prixAchat: isService ? 0 : l.prixAchat,
          unite: l.unite,
          hs: isService,
          actif: true,
          notes: 'Créé par l\'IA après confirmation'
        });
        if (newArt) artId = newArt.id;
      }

      finalItems.push({
        articleId: artId,
        designation: l.designation,
        quantite: l.quantite,
        prix: l.prixUnitaire,
        unite: l.unite,
        remise: 0
      });
    }

    var prefill = {
      type: parsed.document.type === 'facture' ? 'facture' : 'devis',
      clientId: clientId,
      chantierId: chantierId,
      sujet: parsed.document.sujet || '',
      notes: parsed.document.analyse_technique || '',
      items: finalItems,
      tvaRate: parsed.document.tvaRate || 19,
      timbre: parsed.document.timbre || 1.000
    };

    IA.closePreview();
    IA.close();
    U.toast('Références préparées. Vérifie puis enregistre le document.', 'success', 3000);

    if (VC.Invoices && typeof VC.Invoices.openWithPrefill === 'function') {
      VC.Invoices.openWithPrefill(prefill);
    } else {
      U.toast('Erreur : module Facture indisponible.', 'error');
    }
    return true;
  };
  IA.attachEvents = function () {
    var keys = Object.keys(IA_MODELS);
    for (var i = 0; i < keys.length; i++) {
      (function (k) {
        U.on('iaModelBtn_' + k, 'click', function () {
          IA.switchModel(k);
        });
      })(keys[i]);
    }

    U.on('iaCopyBtn', 'click', IA.copyPrompt);
    U.on('iaOpenWebsiteBtn', 'click', IA.openWebsite);
    U.on('iaAnalyzeBtn', 'click', IA.parsePastedJSON);
    U.on('iaUniversalBtn', 'click', IA.importUniversalData);
    U.on('iaGenerateDocBtn', 'click', IA.generateDocumentFromJSON);
    U.on('iaClearBtn', 'click', _clearPaste);

    U.on('iaPreviewConfirmBtn', 'click', IA.confirmImport);
    U.on('iaPreviewCancelBtn', 'click', IA.closePreview);

    U.on('btnOpenAssistantIA', 'click', IA.open);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 10 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  VC._iaLoaded = true;

  VC.logInfo('22-ia', 'Module chargé (seuil similarité ' +
    SIMILARITY_THRESHOLD + ' — C31 corrigé)');

})(window);