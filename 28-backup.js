/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 28-backup.js
   VERSION : v7.0.7
   RÔLE : Backup complet JSON (export + import).
          - Export : TOUTES les collections enregistrées + trash + config
          - Import : détection automatique format (v7 / BASE_BLINDE / article.json)
          - Modes : merge (défaut) ou replace
          - Restauration IDB backups
          - Aperçu avant validation
   DÉPENDANCES : 00-core, 01-utils, 02-store, 03-idb, 26-infra, 27-migrate
   ORDRE : 29ᵉ fichier chargé

   FIX v7.0.0 :
   - C28 : trash exporté ET restauré (toutes les clés, pas juste 3)
   - C29 : externalPrices exporté ET restauré
   - C38/C39 : compat via Migrate.fromLegacy si format legacy détecté
   - Le registre Store pilote l'export : impossible d'oublier une collection

   RÈGLES :
   - ES5 strict
   - Aucun catch silencieux
   - Ne JAMAIS écraser silencieusement : confirmation explicite en mode replace
   - Idempotent en mode merge (skip les doublons par ID + clé naturelle)
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {

  if (!global.VOLTCORE || !global.VOLTCORE.Store ||
      !global.VOLTCORE.Utils || !global.VOLTCORE.IDB) {
    throw new Error('[28-backup] Modules requis non chargés');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var S = VC.Store;
  var IDB = VC.IDB;
  var M = VC.Migrate;
  var B = VC.Backup || {};
  VC.Backup = B;

  /* ═══════════════════════════════════════════════════════════
     SECTION 1 — ÉTAT INTERNE
     ═══════════════════════════════════════════════════════════ */

  var _importing = false;

  var BACKUP_VERSION = 1;
  var BACKUP_MARKER = '_voltcore_backup';
  var BACKUP_APP = 'VOLTCORE';
  var BACKUP_SCHEMA_VERSION = '7.0';

  /* ═══════════════════════════════════════════════════════════
     SECTION 2 — EXPORT
     ═══════════════════════════════════════════════════════════ */

  /**
   * Construit l'objet backup complet.
   * - Itère sur le registre Store (impossible d'oublier une collection)
   * - Inclut trash ouvert (toutes les clés)
   * - Inclut config (rib, mf, logo, etc.)
   * - Inclut compteurs
   * - Inclut externalPrices (via articles, qui a un handler blobs)
   */
  B.buildData = function () {
    var payload = {};
    payload[BACKUP_MARKER] = true;
    payload._version = BACKUP_SCHEMA_VERSION;
    payload._app = BACKUP_APP;
    payload._appVersion = VC.VERSION;
    payload._createdAt = new Date().toISOString();
    payload._user = (VC.Auth && VC.Auth.currentUser && VC.Auth.currentUser.username)
      ? VC.Auth.currentUser.username : 'anon';

    var names = S.listRegistered();
    var collections = {};

    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var spec = S.getSpec(name);
      if (!spec || !spec.backup) continue;

      if (spec.type === 'array') {
        collections[name] = S.getAll(name).slice();
      } else if (spec.type === 'object') {
        collections[name] = _deepClone(S.getObject(name));
      } else if (spec.type === 'string' || spec.type === 'number') {
        collections[name] = S.getValue(name);
      }
    }

    payload.collections = collections;
    payload.blobs = [];
    payload.blobsIncluded = false;

    /* Trash : toutes les clés, pas seulement 3 (fix C28) */
    payload.trash = _deepClone(S.getTrash());

    /* Signatures : métadonnées seulement (blobs IDB exclus) */
    /* Les blobs sont référencés par `ref` — un backup JSON ne peut pas
       transporter les binaires. Les refs sont conservées pour que si
       l'utilisateur restaure sur le MÊME navigateur, tout fonctionne.
       Pour un export cross-device, on ajoute un warning dans l'UI. */

    return payload;
  };

  function _deepClone(obj) {
    if (obj == null) return obj;
    try {
      return JSON.parse(JSON.stringify(obj));
    } catch (e) {
      VC.logError('28-backup', 'deepClone échoué', e);
      return obj;
    }
  }

  /**
   * Export déclenché par le bouton "Exporter (JSON)".
   */
  B.export = function () {
    B.exportAsync().catch(function (e) {
      VC.logError('28-backup', 'export échoué', e);
      U.toast('Erreur d\'export : ' + (e.message || 'inconnue'), 'error', 4000);
    });
    return true;
  };

  B.exportAsync = function () {
    var data = B.buildData();
    var includeBlobs = IDB && IDB.blobs && typeof IDB.blobs.list === 'function';
    var blobTask = includeBlobs ? IDB.blobs.list() : Promise.resolve([]);

    return Promise.resolve(blobTask).then(function (list) {
      var tasks = [];
      for (var i = 0; i < list.length; i++) {
        (function (meta) {
          tasks.push(IDB.blobs.get(meta.id).then(function (record) {
            if (!record || !record.data) return null;
            return IDB.blobToDataURL(record.data).then(function (dataUrl) {
              return {
                id: meta.id,
                mime: record.mime || meta.mime || 'application/octet-stream',
                size: record.size || meta.size || 0,
                createdAt: record.createdAt || meta.createdAt || '',
                dataUrl: dataUrl
              };
            });
          }).catch(function (e) {
            VC.logError('28-backup', 'blob export échoué : ' + meta.id, e);
            return null;
          }));
        })(list[i]);
      }
      return Promise.all(tasks);
    }).then(function (blobs) {
      var included = [];
      for (var i = 0; i < blobs.length; i++) {
        if (blobs[i]) included.push(blobs[i]);
      }
      data.blobs = included;
      data.blobsIncluded = included.length > 0;

      var json = JSON.stringify(data, null, 2);
      var blob = new Blob([json], { type: 'application/json' });
      var filename = 'voltcore-backup-' + U.todayISO() + '.json';
      U.downloadBlob(blob, filename);
      U.toast('Backup exporté : ' + filename +
        (included.length ? ' · ' + included.length + ' fichier(s)' : ''),
        'success', 4000);
      _log('backup.export', filename + ' (' + _formatSize(json.length) +
        ', ' + included.length + ' blobs)');
      return { ok: true, filename: filename, blobs: included.length };
    });
  };

  function _formatSize(bytes) {
    var n = parseInt(bytes, 10) || 0;
    if (n < 1024) return n + ' o';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' Ko';
    return (n / (1024 * 1024)).toFixed(1) + ' Mo';
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 3 — IMPORT : ANALYSE PRÉALABLE
     ═══════════════════════════════════════════════════════════ */

  /**
   * Analyse un fichier JSON avant import. Retourne un rapport pour
   * affichage dans l'UI.
   */
  B.analyzeFile = function (file) {
    return new Promise(function (resolve, reject) {
      if (!file) {
        reject(new Error('Fichier requis'));
        return;
      }

      var reader = new FileReader();
      reader.onload = function (ev) {
        try {
          var raw = ev.target.result;
          var payload = JSON.parse(raw);

          if (!payload || typeof payload !== 'object') {
            reject(new Error('JSON invalide'));
            return;
          }

          var format = M.detectLegacyFormat(payload);
          var analysis = {
            format: format,
            isLegacy: format !== 'v7',
            counts: {},
            warnings: [],
            payload: payload
          };

          /* Compte les collections */
          if (format === 'v7') {
            var cols = payload.collections || {};
            var names = Object.keys(cols);
            for (var i = 0; i < names.length; i++) {
              var n = names[i];
              if (Array.isArray(cols[n])) {
                analysis.counts[n] = cols[n].length;
              } else if (cols[n] && typeof cols[n] === 'object') {
                analysis.counts[n] = Object.keys(cols[n]).length + ' clés';
              }
            }
            if (payload.trash && typeof payload.trash === 'object') {
              var trashKeys = Object.keys(payload.trash);
              var trashTotal = 0;
              for (var j = 0; j < trashKeys.length; j++) {
                var arr = payload.trash[trashKeys[j]];
                if (Array.isArray(arr)) trashTotal += arr.length;
              }
              analysis.counts.trash = trashTotal;
            }
          } else {
            /* Legacy : on devine les collections présentes */
            var legacyCollections = ['clients', 'suppliers', 'articles',
              'familles', 'chantiers', 'documents', 'purchaseInvoices',
              'frais', 'hrEmployees', 'hrWorkEntries', 'hrTransactions'];
            for (var k = 0; k < legacyCollections.length; k++) {
              var key = legacyCollections[k];
              if (Array.isArray(payload[key])) {
                analysis.counts[key] = payload[key].length;
              }
            }
            analysis.warnings.push(
              'Format legacy détecté — les données seront converties automatiquement.'
            );
          }

          resolve(analysis);
        } catch (e) {
          VC.logError('28-backup', 'analyzeFile parse échoué', e);
          reject(e);
        }
      };
      reader.onerror = function () {
        reject(reader.error || new Error('Lecture échouée'));
      };
      reader.readAsText(file);
    });
  };

  /**
   * Demande à l'utilisateur quel mode il veut. Retourne Promise<'merge'|'replace'|null>.
   */
  B.askImportMode = function (analysis) {
    return new Promise(function (resolve) {
      var msg = 'Comment importer ce fichier ?\n\n';
      msg += 'Format : ' + (analysis.isLegacy
        ? 'legacy (converti automatiquement)' : 'v7 natif') + '\n';

      var keys = Object.keys(analysis.counts);
      if (keys.length > 0) {
        msg += 'Contenu :\n';
        for (var i = 0; i < Math.min(keys.length, 8); i++) {
          msg += '  • ' + keys[i] + ' : ' + analysis.counts[keys[i]] + '\n';
        }
        if (keys.length > 8) msg += '  • …\n';
      }

      msg += '\nTape :\n';
      msg += '  FUSIONNER — ajoute sans supprimer l\'existant (recommandé)\n';
      msg += '  REMPLACER — écrase TOUTES les données actuelles (danger)\n';
      msg += '  Annule pour abandonner';

      var choice = U.prompt(msg, '');
      if (choice === null) {
        resolve(null);
        return;
      }

      var normalized = String(choice).toUpperCase().trim();
      if (normalized === 'REMPLACER') resolve('replace');
      else if (normalized === 'FUSIONNER' || normalized === '') resolve('merge');
      else resolve(null);
    });
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 4 — IMPORT : EXÉCUTION
     ═══════════════════════════════════════════════════════════ */

  function _validateBackupBlobs(blobs) {
    if (blobs == null) return Promise.resolve([]);
    if (!Array.isArray(blobs) || blobs.length > 10000) {
      return Promise.reject(new Error('Liste de pièces jointes invalide ou trop volumineuse.'));
    }
    if (!IDB || !IDB.blobs || typeof IDB.blobs.put !== 'function' ||
        typeof IDB.blobs.putIfAbsent !== 'function' ||
        typeof IDB.blobs.getStrict !== 'function' ||
        typeof IDB.dataURLToBlob !== 'function' ||
        typeof IDB.blobToDataURL !== 'function' ||
        typeof IDB.validateDocumentBlob !== 'function') {
      return Promise.reject(new Error('Validation des pièces jointes indisponible.'));
    }

    var seen = Object.create(null);
    var tasks = [];
    for (var i = 0; i < blobs.length; i++) {
      (function (entry) {
        if (!entry || typeof entry.id !== 'string' || !entry.id ||
            entry.id.length > 256 || seen[entry.id] ||
            typeof entry.mime !== 'string' || typeof entry.dataUrl !== 'string' ||
            entry.dataUrl.length > Math.ceil(VC.DOCLIB_MAX_BYTES * 4 / 3) + 256) {
          tasks.push(Promise.reject(new Error('Pièce jointe invalide dans la sauvegarde.')));
          return;
        }
        seen[entry.id] = true;

        var dataUrlMime = entry.dataUrl.match(/^data:([^;,]+);base64,/i);
        if (!dataUrlMime || dataUrlMime[1].toLowerCase() !== entry.mime.toLowerCase()) {
          tasks.push(Promise.reject(new Error('Type MIME incohérent dans la sauvegarde.')));
          return;
        }
        tasks.push(IDB.dataURLToBlob(entry.dataUrl).then(function (blob) {
          if (blob.size > VC.DOCLIB_MAX_BYTES ||
              (entry.size != null && Number(entry.size) !== blob.size)) {
            throw new Error('Taille de pièce jointe invalide dans la sauvegarde.');
          }
          return IDB.validateDocumentBlob(blob, entry.mime).then(function (valid) {
            if (!valid) {
              throw new Error('Contenu de pièce jointe invalide ou type interdit.');
            }
            return { id: entry.id, mime: entry.mime.toLowerCase(), blob: blob };
          });
        }));
      })(blobs[i]);
    }
    return Promise.all(tasks);
  }

  function _prepareBlobRestore(blobs, mode) {
    if (mode === 'replace' || !blobs.length) return Promise.resolve(blobs);
    var tasks = [];
    for (var i = 0; i < blobs.length; i++) {
      (function (entry) {
        tasks.push(IDB.blobs.getStrict(entry.id).then(function (existing) {
          if (!existing) return entry;
          if (!existing.data || existing.mime !== entry.mime ||
              existing.data.type !== entry.blob.type) {
            throw new Error('Une pièce jointe existe déjà avec un type différent. ' +
              'Utilise le mode REMPLACER après une sauvegarde.');
          }
          return Promise.all([
            IDB.blobToDataURL(existing.data),
            IDB.blobToDataURL(entry.blob)
          ]).then(function (dataUrls) {
            var oldBytes = dataUrls[0].slice(dataUrls[0].indexOf(',') + 1);
            var newBytes = dataUrls[1].slice(dataUrls[1].indexOf(',') + 1);
            if (oldBytes !== newBytes) {
              throw new Error('Collision d’identifiant de pièce jointe détectée. ' +
                'Utilise le mode REMPLACER après une sauvegarde.');
            }
            return { id: entry.id, mime: entry.mime, blob: entry.blob, skipWrite: true };
          });
        }));
      })(blobs[i]);
    }
    return Promise.all(tasks);
  }

  function _restoreBlobs(blobs, mode) {
    if (!Array.isArray(blobs) || blobs.length === 0) return Promise.resolve(0);
    var tasks = [];
    for (var i = 0; i < blobs.length; i++) {
      (function (entry) {
        if (entry.skipWrite) {
          tasks.push(Promise.resolve(false));
          return;
        }
        var write = mode === 'replace'
          ? IDB.blobs.put(entry.id, entry.blob, entry.mime)
          : IDB.blobs.putIfAbsent(entry.id, entry.blob, entry.mime);
        tasks.push(write.then(function () {
          return true;
        }));
      })(blobs[i]);
    }
    return Promise.all(tasks).then(function (results) {
      var restored = 0;
      for (var j = 0; j < results.length; j++) {
        if (results[j]) restored++;
      }
      return restored;
    });
  }

  B.importFile = function (file) {
    if (_importing) return Promise.reject(new Error('Import déjà en cours'));
    _importing = true;

    return B.analyzeFile(file).then(function (analysis) {
      return _validateBackupBlobs(analysis.payload && analysis.payload.blobs).then(function (blobs) {
        analysis.validatedBlobs = blobs;
        return B.askImportMode(analysis);
      }).then(function (mode) {
        if (!mode) {
          _importing = false;
          throw new Error('Import annulé par l\'utilisateur');
        }
        return _prepareBlobRestore(analysis.validatedBlobs, mode).then(function (blobs) {
          analysis.validatedBlobs = blobs;
          return mode;
        });
      }).then(function (mode) {

        if (mode === 'replace') {
          // FIX R60 : compter les items qui seront poussés en corbeille
          // et avertir explicitement si > 100 (au lieu de la limite cachée).
          var _totalCurrent = 0;
          var _namesForCount = S.listRegistered();
          for (var _ni = 0; _ni < _namesForCount.length; _ni++) {
            var _spec = S.getSpec(_namesForCount[_ni]);
            if (!_spec || _spec.type !== 'array' || !_spec.trash) continue;
            _totalCurrent += S.getAll(_namesForCount[_ni]).length;
          }

          var _warningDetail = '';
          if (_totalCurrent > 0) {
            _warningDetail = '• ' + _totalCurrent + ' élément(s) actuel(s) ' +
              'seront poussés dans la corbeille (restaurables pendant ' +
              VC.TRASH_MAX_DAYS + ' jours).\n\n';
          }
          if (_totalCurrent > 1000) {
            _warningDetail +=
              '⚠️ IMPORTANT : ' + _totalCurrent + ' éléments, c\'est beaucoup. ' +
              'Vérifie que tu as un backup récent ET que tu es sûr.\n\n';
          }

          var ok = U.confirm(
            '⚠ Mode REMPLACER : TOUTES les données actuelles seront écrasées.\n\n' +
            _warningDetail +
            'Une copie de sécurité automatique sera téléchargée avant le remplacement.\n\n' +
            'Continuer ?'
          );
          if (!ok) {
            _importing = false;
            throw new Error('Import annulé (confirmation replace refusée)');
          }

          return B.exportAsync().then(function () {
            U.toast('Sauvegarde de sécurité créée avant remplacement', 'success', 4000);
          }).catch(function (e) {
            VC.logError('28-backup', 'Sauvegarde de sécurité avant replace échouée', e);
            var continueWithoutBackup = U.confirm(
              'Impossible de créer la sauvegarde de sécurité automatique.\n\n' +
              'Remplacer quand même les données ?'
            );
            if (!continueWithoutBackup) {
              throw new Error('Import annulé (backup de sécurité impossible)');
            }
          }).then(function () {
            return _completeImport(analysis, mode);
          });
        }

        return _completeImport(analysis, mode);
      });
    }).then(function (result) {
      _importing = false;
      return result;
    }).catch(function (e) {
      _importing = false;
      VC.logError('28-backup', 'importFile échoué', e);
      throw e;
    });
  };

  function _completeImport(analysis, mode) {
    var blobs = analysis.validatedBlobs || [];
    return _restoreBlobs(blobs, mode).then(function (restored) {
      var stats = _executeImport(analysis, mode);
      stats.blobsRestored = restored;
      return stats;
    });
  }

  function _executeImport(analysis, mode) {
    var collections;
    var trash;

    if (analysis.isLegacy) {
      /* Conversion legacy via Migrate */
      var converted = M.fromLegacy(analysis.payload);
      collections = converted.collections;
      trash = null; /* Les legacy n'ont pas de trash v7 */
      if (converted.warnings.length > 0) {
        VC.logWarn('28-backup', 'Migration legacy — warnings', converted.warnings);
      }
    } else {
      collections = analysis.payload.collections || {};
      trash = analysis.payload.trash || null;
    }

    /* ── Étape 1 : mode replace — pousser à la corbeille ── */
    if (mode === 'replace') {
      _pushAllToTrash(collections);
    }

    /* ── Étape 2 : importer chaque collection ── */
    var stats = { added: 0, skipped: 0, invalid: 0, byCollection: {} };
    var names = Object.keys(collections);

    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var value = collections[name];
      var spec = S.getSpec(name);

      if (!spec) {
        VC.logWarn('28-backup', 'Collection inconnue ignorée : ' + name);
        continue;
      }

      if (spec.type === 'array') {
        var r = _importArray(name, value, mode);
        stats.added += r.added;
        stats.skipped += r.skipped;
        stats.invalid += r.invalid;
        stats.byCollection[name] = r;
      } else if (spec.type === 'object') {
        if (mode === 'replace') {
          S.setObject(name, value || {});
        } else {
          /* Merge : fusion superficielle */
          var existing = S.getObject(name);
          var merged = _mergeObjects(existing, value || {});
          S.setObject(name, merged);
        }
        stats.byCollection[name] = { merged: true };
      } else if (spec.type === 'string' || spec.type === 'number') {
        if (mode === 'replace' && value != null) {
          S.setValue(name, value);
        }
        stats.byCollection[name] = { restored: mode === 'replace' };
      }
    }

    /* ── Étape 3 : restaurer la corbeille (fix C28) ── */
    if (trash && mode === 'replace') {
      _restoreTrash(trash);
    } else if (trash && mode === 'merge') {
      _mergeTrash(trash);
    }

    /* ── Étape 4 : saveAll + log ── */
    S.saveAll();
    _log('backup.import', mode + ' : ' + stats.added + ' ajoutés, ' +
      stats.skipped + ' doublons');

    /* ── Étape 5 : refresh global ── */
    _refreshAllUI();

    U.toast('Import terminé : ' + stats.added + ' ajout(s)' +
      (stats.skipped > 0 ? ' · ' + stats.skipped + ' doublon(s)' : ''),
      'success', 4000);

    return stats;
  }

  function _importArray(name, value, mode) {
    var result = { added: 0, skipped: 0, invalid: 0 };

    if (!Array.isArray(value)) {
      result.invalid++;
      return result;
    }

    if (mode === 'replace') {
      S.replaceAll(name, value);
      result.added = value.length;
      return result;
    }

    /* Merge : par ID + clé naturelle selon la collection */
    var existing = S.getAll(name);
    var existingById = {};
    for (var i = 0; i < existing.length; i++) {
      if (existing[i] && existing[i].id) {
        existingById[String(existing[i].id)] = true;
      }
    }

    var existingNaturalKeys = _buildNaturalKeys(name, existing);

    for (var j = 0; j < value.length; j++) {
      var item = value[j];
      if (!item || typeof item !== 'object') {
        result.invalid++;
        continue;
      }

      /* Doublon par ID */
      if (item.id && existingById[String(item.id)]) {
        result.skipped++;
        continue;
      }

      /* Doublon par clé naturelle */
      var natKey = _naturalKey(name, item);
      if (natKey && existingNaturalKeys[natKey]) {
        result.skipped++;
        continue;
      }

      /* Sauvegarde */
      var saved = S.save(name, item);
      if (saved) {
        result.added++;
        if (item.id) existingById[String(item.id)] = true;
        if (natKey) existingNaturalKeys[natKey] = true;
      } else {
        result.invalid++;
      }
    }

    return result;
  }

  function _buildNaturalKeys(name, items) {
    var map = {};
    for (var i = 0; i < items.length; i++) {
      var k = _naturalKey(name, items[i]);
      if (k) map[k] = true;
    }
    return map;
  }

  function _naturalKey(name, item) {
    if (!item || typeof item !== 'object') return null;

    if (name === 'documents' || name === 'purchaseInvoices') {
      var num = String(item.numero || item.refFacture || '').trim();
      var dt = String(item.date || item.dateFacture || '').slice(0, 10);
      if (num && dt) return 'num:' + num + '|date:' + dt;
      return null;
    }
    if (name === 'clients' || name === 'suppliers' ||
        name === 'chantiers' || name === 'hrEmployees' ||
        name === 'articles' || name === 'familles') {
      var nom = String(item.nom || item.designation || '').trim();
      if (nom) return 'nom:' + U.normalizeText(nom);
      return null;
    }
    if (name === 'bonsRoute') {
      var n = String(item.numero || '').trim();
      if (n) return 'num:' + n;
      return null;
    }
    return null;
  }

  function _mergeObjects(a, b) {
    var out = {};
    var keysA = Object.keys(a || {});
    for (var i = 0; i < keysA.length; i++) out[keysA[i]] = a[keysA[i]];
    var keysB = Object.keys(b || {});
    for (var j = 0; j < keysB.length; j++) out[keysB[j]] = b[keysB[j]];
    return out;
  }

  function _pushAllToTrash(collections) {
    var names = Object.keys(collections);
    var pushed = 0;
    var internalTrash = S.getTrash(); // On récupère la corbeille en mémoire

    for (var i = 0; i < names.length; i++) {
      var name = names[i];
      var spec = S.getSpec(name);
      if (!spec || spec.type !== 'array' || !spec.trash) continue;

      var current = S.getAll(name);
      
      // On s'assure que le dossier existe dans la corbeille
      if (!Array.isArray(internalTrash[name])) {
        internalTrash[name] = [];
      }

      var now = new Date().toISOString();
      var user = 'anon';
      if (VC.Auth && VC.Auth.currentUser && VC.Auth.currentUser.username) {
        user = String(VC.Auth.currentUser.username);
      }

      for (var j = 0; j < current.length; j++) {
        if (current[j]) {
          // FIX : On ajoute directement dans la mémoire, sans sauvegarder le localStorage
          internalTrash[name].push({
            item: current[j],
            deletedAt: now,
            deletedBy: user
          });
          pushed++;
        }
      }
    }

    if (pushed > 0) {
      // On sauvegarde TOUT d'un seul coup dans le localStorage
      try {
        localStorage.setItem('voltcore_trash', JSON.stringify(internalTrash));
      } catch(e) {
        VC.logError('28-backup', 'sauvegarde trash échouée', e);
      }
      VC.logInfo('28-backup', pushed + ' élément(s) poussé(s) dans la corbeille (optimisé)');
    }
  }

  function _restoreTrash(trash) {
    if (!trash || typeof trash !== 'object') return;

    var internal = S.getTrash();
    var keys = Object.keys(trash);

    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var entries = trash[key];
      if (!Array.isArray(entries)) continue;

      if (!Array.isArray(internal[key])) internal[key] = [];
      for (var j = 0; j < entries.length; j++) {
        if (entries[j]) internal[key].push(entries[j]);
      }
    }
  }

  function _mergeTrash(trash) {
    /* En mode merge, on ajoute les entrées du backup qui ne sont pas déjà présentes
       (par ID d'item) */
    if (!trash || typeof trash !== 'object') return;

    var internal = S.getTrash();
    var keys = Object.keys(trash);

    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var entries = trash[key];
      if (!Array.isArray(entries)) continue;

      if (!Array.isArray(internal[key])) internal[key] = [];

      var existingIds = {};
      for (var m = 0; m < internal[key].length; m++) {
        if (internal[key][m] && internal[key][m].item && internal[key][m].item.id) {
          existingIds[String(internal[key][m].item.id)] = true;
        }
      }

      for (var j = 0; j < entries.length; j++) {
        var entry = entries[j];
        if (!entry || !entry.item || !entry.item.id) continue;
        if (existingIds[String(entry.item.id)]) continue;
        internal[key].push(entry);
        existingIds[String(entry.item.id)] = true;
      }
    }
  }

  function _refreshAllUI() {
    try { if (VC.Clients && VC.Clients.render) VC.Clients.render(); } catch (e) {
      VC.logError('28-backup', 'refresh clients échoué', e);
    }
    try { if (VC.Suppliers && VC.Suppliers.render) VC.Suppliers.render(); } catch (e) {
      VC.logError('28-backup', 'refresh suppliers échoué', e);
    }
    try { if (VC.Stock && VC.Stock.render) VC.Stock.render(); } catch (e) {
      VC.logError('28-backup', 'refresh stock échoué', e);
    }
    try { if (VC.Chantiers && VC.Chantiers.render) VC.Chantiers.render(); } catch (e) {
      VC.logError('28-backup', 'refresh chantiers échoué', e);
    }
    try { if (VC.HR && VC.HR.render) VC.HR.render(); } catch (e) {
      VC.logError('28-backup', 'refresh hr échoué', e);
    }
    try { if (VC.InvoicesView && VC.InvoicesView.render) VC.InvoicesView.render(); } catch (e) {
      VC.logError('28-backup', 'refresh invoices échoué', e);
    }
    try { if (VC.Purchases && VC.Purchases.render) VC.Purchases.render(); } catch (e) {
      VC.logError('28-backup', 'refresh purchases échoué', e);
    }
    try { if (VC.Frais && VC.Frais.render) VC.Frais.render(); } catch (e) {
      VC.logError('28-backup', 'refresh frais échoué', e);
    }
    try { if (VC.Route && VC.Route.render) VC.Route.render(); } catch (e) {
      VC.logError('28-backup', 'refresh route échoué', e);
    }
    try { if (VC.Documents && VC.Documents.render) VC.Documents.render(); } catch (e) {
      VC.logError('28-backup', 'refresh documents échoué', e);
    }
    try { if (VC.Dashboard && VC.Dashboard.render) VC.Dashboard.render(); } catch (e) {
      VC.logError('28-backup', 'refresh dashboard échoué', e);
    }
    try { if (VC.Tools && VC.Tools.renderTrash) VC.Tools.renderTrash(); } catch (e) {
      VC.logError('28-backup', 'refresh tools échoué', e);
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 5 — IMPORT UI
     ═══════════════════════════════════════════════════════════ */

  B.importViaFilePicker = function () {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (!f) return;
      B.importFile(f).catch(function (err) {
        if (err.message && err.message.indexOf('annulé') !== -1) return;
        U.toast('Import échoué : ' + (err.message || ''), 'error', 5000);
      });
    };
    input.click();
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 6 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  function _log(action, details) {
    try {
      var history = S.getAll('history');
      history.push({
        date: new Date().toISOString(),
        user: (VC.Auth && VC.Auth.currentUser && VC.Auth.currentUser.username)
          ? VC.Auth.currentUser.username : 'anon',
        action: action,
        details: String(details || '')
      });
      if (history.length > VC.HISTORY_MAX_ENTRIES) {
        history = history.slice(-VC.HISTORY_MAX_ENTRIES);
      }
      S.replaceAll('history', history);
    } catch (e) {
      VC.logError('28-backup', '_log échoué', e);
    }
  }

  /* ═══════════════════════════════════════════════════════════
     SECTION 7 — EVENTS
     ═══════════════════════════════════════════════════════════ */

  B.attachEvents = function () {
    U.on('btnExportCompleteBackup', 'click', B.export);
    U.on('btnImportCompleteBackup', 'click', B.importViaFilePicker);
  };

  /* ═══════════════════════════════════════════════════════════
     SECTION 8 — MARQUEUR
     ═══════════════════════════════════════════════════════════ */

  VC._backupLoaded = true;

  VC.logInfo('28-backup', 'Module chargé (trash + externalPrices + legacy)');

})(window);