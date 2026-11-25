/* ═══════════════════════════════════════════════════════════
   VOLTCORE — 31-license.js
   RÔLE : Licence annuelle ECDSA hors ligne, activation et blocage.
   ORDRE : chargé avant 30-boot.js
   ═══════════════════════════════════════════════════════════ */

'use strict';

(function (global) {
  if (!global.VOLTCORE || !global.VOLTCORE.Utils) {
    throw new Error('[31-license] 00-core.js et 01-utils.js requis');
  }

  var VC = global.VOLTCORE;
  var U = VC.Utils;
  var License = VC.License || {};
  VC.License = License;

  var STORAGE_KEY = 'voltcore_license_token';
  var LAST_SEEN_KEY = 'voltcore_license_last_seen';
  var GRACE_DAYS = 14;

  var INITIAL_TOKEN = 'VC1.eyJ2IjoxLCJwIjoiVk9MVENPUkUiLCJpIjoiMTk3NzQ2M1AiLCJuIjoiVk9MVENPUkUgSU5HRU5JRVJJRSIsImlzc3VlZCI6IjIwMjYtMDktMjgiLCJleHBpcmVzIjoiMjAyNy0wOS0yOCJ9.k3kITur7NHFoDaP9BoC13TlsqaapJ6pifAVBh7mUvQzAyQiz3qU-R4SezgXfvmN2xEmu_Q7S4psTGWi85tZBNw';

  var PUBLIC_KEY_PEM =
    '-----BEGIN PUBLIC KEY-----\n' +
    'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEiKQJS0e73Id8r/SC4FcsMoFo0acC\n' +
    'BiXK2HuscUjg7SOifmW5L/yr1TfZXNBdtmMPzTb+dMtAKzpqnT6SZQfahQ==\n' +
    '-----END PUBLIC KEY-----';

  function base64UrlToBytes(value) {
    var base64 = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    var binary = atob(base64);
    var out = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }

  function pemToBytes(pem) {
    var base64 = String(pem)
      .replace(/-----BEGIN PUBLIC KEY-----/g, '')
      .replace(/-----END PUBLIC KEY-----/g, '')
      .replace(/\s+/g, '');
    return base64UrlToBytes(base64);
  }

  function dateOnly(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
    var d = new Date(String(value) + 'T00:00:00Z');
    if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== value) return null;
    return d;
  }

  function todayUTC() {
    var d = new Date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  }

  function _clockRollbackDetected() {
    try {
      var raw = localStorage.getItem(LAST_SEEN_KEY);
      var lastSeen = raw ? parseInt(raw, 10) : 0;
      if (!lastSeen) return false;
      var now = Date.now();
      return lastSeen - now > 24 * 60 * 60 * 1000;
    } catch (e) {
      VC.logError('31-license', 'Vérification horloge locale échoué', e);
      return false;
    }
  }

  function _decodePayload(token) {
    if (typeof token !== 'string') return null;
    var parts = token.trim().split('.');
    if (parts.length !== 3 || parts[0] !== 'VC1') return null;

    try {
      var payloadBytes = base64UrlToBytes(parts[1]);
      var json = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes);
      var payload = JSON.parse(json);
      if (!payload || payload.v !== 1 || payload.p !== 'VOLTCORE' ||
          payload.i !== '1977463P' || payload.n !== 'VOLTCORE INGENIERIE') {
        return null;
      }
      return { payload: payload, payloadPart: parts[1], signaturePart: parts[2] };
    } catch (e) {
      VC.logError('31-license', 'Décodage licence échoué', e);
      return null;
    }
  }

  function _verifySignature(decoded) {
    if (!decoded || !global.crypto || !global.crypto.subtle) {
      return Promise.resolve(false);
    }

    return global.crypto.subtle.importKey(
      'spki', pemToBytes(PUBLIC_KEY_PEM),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, ['verify']
    ).then(function (publicKey) {
      var payloadBytes = new TextEncoder().encode(decoded.payloadPart);
      var signatureBytes = base64UrlToBytes(decoded.signaturePart);
      return global.crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        signatureBytes,
        payloadBytes
      );
    }).catch(function (e) {
      VC.logError('31-license', 'Vérification signature licence échoué', e);
      return false;
    });
  }

  function _evaluate(decoded) {
    if (!decoded) {
      return { valid: false, expired: false, grace: false, reason: 'Format de licence invalide' };
    }

    var issued = dateOnly(decoded.payload.issued);
    var expires = dateOnly(decoded.payload.expires);
    if (!issued || !expires || expires < issued) {
      return { valid: false, expired: false, grace: false, reason: 'Dates de licence invalides' };
    }

    var maxExpiry = new Date(issued.getTime());
    maxExpiry.setUTCDate(maxExpiry.getUTCDate() + 370);
    if (expires > maxExpiry) {
      return { valid: false, expired: false, grace: false, reason: 'Durée de licence excessive' };
    }

    var now = todayUTC();
    var issuedTime = issued.getTime();
    if (issuedTime > now + (24 * 60 * 60 * 1000)) {
      return { valid: false, expired: false, grace: false, reason: 'Licence émise dans le futur' };
    }
    var expiryTime = expires.getTime();
    if (now <= expiryTime) {
      return {
        valid: true,
        expired: false,
        grace: false,
        issued: decoded.payload.issued,
        expires: decoded.payload.expires
      };
    }

    var graceEnd = expiryTime + (GRACE_DAYS * 24 * 60 * 60 * 1000);
    if (now <= graceEnd) {
      return {
        valid: true,
        expired: true,
        grace: true,
        issued: decoded.payload.issued,
        expires: decoded.payload.expires,
        reason: 'Période de grâce active'
      };
    }

    return {
      valid: false,
      expired: true,
      grace: false,
      issued: decoded.payload.issued,
      expires: decoded.payload.expires,
      reason: 'Licence expirée'
    };
  }

  function _getStoredToken() {
    try {
      return localStorage.getItem(STORAGE_KEY) || INITIAL_TOKEN;
    } catch (e) {
      VC.logError('31-license', 'Lecture licence échouée', e);
      return INITIAL_TOKEN;
    }
  }

  function _setStoredToken(token) {
    try {
      localStorage.setItem(STORAGE_KEY, token);
      localStorage.setItem(LAST_SEEN_KEY, String(Date.now()));
      return true;
    } catch (e) {
      VC.logError('31-license', 'Stockage licence échoué', e);
      return false;
    }
  }

  function _showLicense(status) {
    try {
      var modal = document.getElementById('licenseModal');
      var statusEl = document.getElementById('licenseStatus');
      if (statusEl) {
        if (status && status.expired) {
          statusEl.textContent = 'Licence expirée le ' + status.expires + '. Période de grâce: ' + GRACE_DAYS + ' jours.';
        } else if (status) {
          statusEl.textContent = status.reason || 'Licence requise.';
        } else {
          statusEl.textContent = 'Licence requise.';
        }
      }
      if (modal) modal.style.display = 'flex';
      if (U.hide) U.hide('appRoot');
      if (U.hide) U.hide('appSkeleton');
    } catch (e) {
      VC.logError('31-license', 'Affichage licence échoué', e);
    }
  }

  function _hideLicense() {
    try {
      if (U.hide) U.hide('licenseModal');
    } catch (e) {
      VC.logError('31-license', 'Fermeture licence échouée', e);
    }
  }

  License.validateToken = function (token) {
    var decoded = _decodePayload(token);
    var evaluation = _evaluate(decoded);
    if (!evaluation.valid) return Promise.resolve(evaluation);

    return _verifySignature(decoded).then(function (validSignature) {
      if (!validSignature) {
        return { valid: false, expired: false, grace: false, reason: 'Signature de licence invalide' };
      }
      return evaluation;
    });
  };

  License.activate = function () {
    var input = document.getElementById('licenseKeyInput');
    var statusEl = document.getElementById('licenseStatus');
    var token = input ? String(input.value || '').trim() : '';

    if (!token) {
      if (statusEl) statusEl.textContent = 'Colle une clé de licence.';
      return Promise.resolve(false);
    }

    return License.validateToken(token).then(function (result) {
      if (!result.valid) {
        if (statusEl) statusEl.textContent = result.reason || 'Licence invalide.';
        U.toast('Licence refusée : ' + (result.reason || 'clé invalide'), 'error', 5000);
        return false;
      }

      if (!_setStoredToken(token)) {
        if (statusEl) statusEl.textContent = 'Impossible d’enregistrer la licence.';
        return false;
      }

      _hideLicense();
      U.toast(result.grace ? 'Licence renouvelée — période de grâce' : 'Licence activée',
        result.grace ? 'warning' : 'success', 4000);

      License.updateBadge(result);
      if (typeof VC.checkLogin === 'function') VC.checkLogin();
      else if (VC.Auth && typeof VC.Auth.checkLogin === 'function') VC.Auth.checkLogin();
      return true;
    });
  };

  License.updateBadge = function (status) {
    try {
      var badge = document.getElementById('licenseExpiryBadge');
      if (!badge) return;
      if (!status || !status.valid) {
        badge.textContent = 'Licence requise';
        badge.style.display = 'inline-flex';
        return;
      }
      badge.textContent = status.grace
        ? 'Licence - grâce'
        : 'Licence - ' + status.expires;
      badge.style.display = 'inline-flex';
    } catch (e) {
      VC.logError('31-license', 'Badge licence échoué', e);
    }
  };

  License.boot = function () {
    if (_clockRollbackDetected()) {
      var rollbackResult = {
        valid: false,
        expired: false,
        grace: false,
        reason: 'Horloge locale incohérente — restaure la date système'
      };
      License.updateBadge(null);
      _showLicense(rollbackResult);
      return Promise.resolve(false);
    }

    var token = _getStoredToken();
    return License.validateToken(token).then(function (result) {
      License.updateBadge(result.valid ? result : null);
      if (result.valid) {
        _setStoredToken(token);
        _hideLicense();
        return true;
      }

      _showLicense(result);
      return false;
    });
  };

  VC.bootWithLicense = License.boot;
  VC.activateVoltcoreLicense = License.activate;
  VC.exportBackupFromLicenseGate = function () {
    if (VC.Backup && typeof VC.Backup.export === 'function') {
      VC.Backup.export();
    } else {
      U.toast('Sauvegarde non disponible.', 'error', 3000);
    }
  };

  License.attachEvents = function () {
    if (!U.on) return;
    U.on('activateLicenseBtn', 'click', function () {
      License.activate();
    });
  };

  VC._licenseLoaded = true;
  VC.logInfo('31-license', 'Module licence chargé');
})(window);
