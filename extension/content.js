// ZeeApply Apply Assistant — content script.
// Runs on Greenhouse / Lever / Ashby pages, listens for a "fill" message
// from the popup, and fills detectable fields.

(() => {
  // ─── Field map: profile keys → set of label/name/id signals to match ───
  // Multiple signals per field. We try them in order; the first match wins.
  // All comparisons are case-insensitive substring matches against either
  // input attributes (name/id/autocomplete/aria-label) or the visible label.
  const FIELD_SIGNALS = {
    firstName: {
      attrs: ['first_name', 'firstname', 'first-name', 'given-name'],
      labels: ['first name', 'given name'],
    },
    lastName: {
      attrs: ['last_name', 'lastname', 'last-name', 'family-name', 'surname'],
      labels: ['last name', 'family name', 'surname'],
    },
    // Some ATSs (Lever) use a single "name" field
    fullName: {
      attrs: ['^name$', 'full_name', 'fullname', 'full-name'],
      labels: ['^name$', 'full name', 'your name'],
    },
    email: {
      attrs: ['email', 'mail'],
      labels: ['email', 'e-mail'],
      types: ['email'],
    },
    phone: {
      attrs: ['phone', 'mobile', 'tel'],
      labels: ['phone', 'mobile', 'tel'],
      types: ['tel'],
    },
    location: {
      attrs: ['location', 'city', 'address'],
      labels: ['location', 'city', 'where are you located', 'current location'],
    },
    linkedin: {
      attrs: ['linkedin'],
      labels: ['linkedin'],
    },
    portfolio: {
      attrs: ['portfolio', 'website', 'personal_site', 'personal-site'],
      labels: ['portfolio', 'website', 'personal site'],
    },
    github: {
      attrs: ['github'],
      labels: ['github'],
    },
    referral: {
      attrs: ['hear_about', 'how_did_you_hear', 'referral', 'source'],
      labels: ['how did you hear', 'where did you hear', 'how did you find'],
    },
    workAuth: {
      attrs: ['work_auth', 'authorization', 'sponsorship', 'visa'],
      labels: ['work authorization', 'sponsorship', 'visa', 'authorized to work'],
    },
    pronouns: {
      attrs: ['pronoun'],
      labels: ['pronoun'],
    },
    // Cover letter is a special case — keyed off `coverLetter` from the popup,
    // not from the profile object.
    coverLetter: {
      attrs: ['cover_letter', 'cover-letter', 'message', 'comments', 'additional_information', 'additional-information'],
      labels: ['cover letter', 'comments', 'additional information', 'why are you interested', 'additional notes'],
    },
  };

  // ─── Helpers ───────────────────────────────────────────────────────────
  const norm = (s) => (s || '').toString().toLowerCase().trim();

  // Find the visible label text associated with an input element.
  function labelText(el) {
    // 1. Native <label for="ID">
    if (el.id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lbl) return norm(lbl.textContent);
    }
    // 2. Ancestor <label>
    let p = el.parentElement;
    while (p) {
      if (p.tagName === 'LABEL') return norm(p.textContent);
      p = p.parentElement;
    }
    // 3. Preceding sibling label / div with .label class / fieldset legend
    const prev = el.previousElementSibling;
    if (prev && /label/i.test(prev.tagName)) return norm(prev.textContent);
    // 4. aria-labelledby
    if (el.getAttribute('aria-labelledby')) {
      const ref = document.getElementById(el.getAttribute('aria-labelledby'));
      if (ref) return norm(ref.textContent);
    }
    // 5. aria-label
    if (el.getAttribute('aria-label')) return norm(el.getAttribute('aria-label'));
    // 6. placeholder is sometimes the only signal
    if (el.placeholder) return norm(el.placeholder);
    return '';
  }

  // Match a single input element to a set of signals.
  // signals = { attrs?: string[], labels?: string[], types?: string[] }
  function matchSignals(el, signals) {
    const name = norm(el.name);
    const id = norm(el.id);
    const ac = norm(el.getAttribute('autocomplete'));
    const aria = norm(el.getAttribute('aria-label'));
    const lbl = labelText(el);
    const type = norm(el.type);

    const haystack = [name, id, ac, aria].join(' ');

    if (signals.types && signals.types.includes(type)) return true;
    if (signals.attrs) {
      for (const a of signals.attrs) {
        // Allow ^...$ regex anchors for exact match (used by `fullName` to
        // avoid matching first_name / last_name / company_name)
        if (a.startsWith('^') && a.endsWith('$')) {
          const re = new RegExp(a, 'i');
          if (re.test(name) || re.test(id) || re.test(ac)) return true;
        } else if (haystack.includes(a)) {
          return true;
        }
      }
    }
    if (signals.labels) {
      for (const l of signals.labels) {
        if (l.startsWith('^') && l.endsWith('$')) {
          const re = new RegExp(l, 'i');
          if (re.test(lbl)) return true;
        } else if (lbl.includes(l)) {
          return true;
        }
      }
    }
    return false;
  }

  // Set a value on an input and dispatch the right events so React / Vue
  // / vanilla form state libraries actually pick it up. Just setting .value
  // is often ignored by React-controlled inputs.
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  // ─── Fill action ───────────────────────────────────────────────────────
  function fillForm(profile, coverLetter) {
    const inputs = Array.from(document.querySelectorAll(
      'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]):not([type=file]), textarea'
    ));
    // Filter to visible inputs only
    const visible = inputs.filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !el.disabled && !el.readOnly;
    });

    // Build the value map per profile key
    let firstName = profile.firstName || '';
    let lastName = profile.lastName || '';
    const fullNameValue = (firstName + ' ' + lastName).trim();

    const values = {
      firstName,
      lastName,
      fullName: fullNameValue,
      email: profile.email || '',
      phone: profile.phone || '',
      location: profile.location || '',
      linkedin: profile.linkedin || '',
      portfolio: profile.portfolio || '',
      github: profile.github || '',
      referral: profile.referral || '',
      workAuth: profile.workAuth || '',
      pronouns: profile.pronouns || '',
      coverLetter: coverLetter || '',
    };

    let attempted = 0, filled = 0;
    // Track which inputs we've already filled so we don't overwrite — first
    // matching key wins. Order matters: more specific (firstName/lastName)
    // should be checked before generic (fullName).
    const claimed = new WeakSet();
    const order = [
      'firstName', 'lastName', 'fullName', 'email', 'phone', 'location',
      'linkedin', 'portfolio', 'github', 'referral', 'workAuth', 'pronouns',
      'coverLetter',
    ];

    for (const key of order) {
      const val = values[key];
      if (!val) continue;
      const signals = FIELD_SIGNALS[key];
      if (!signals) continue;
      for (const el of visible) {
        if (claimed.has(el)) continue;
        if (!matchSignals(el, signals)) continue;
        attempted++;
        try {
          setNativeValue(el, val);
          claimed.add(el);
          filled++;
        } catch (e) {
          console.warn('[ZeeApply] failed to fill', key, e);
        }
        break;  // one input per key — done with this key
      }
    }

    showPill(`ZeeApply: filled ${filled} / ${attempted} fields. Review carefully before submitting.`);
    return { attempted, filled };
  }

  // ─── Confirmation pill ─────────────────────────────────────────────────
  function showPill(text) {
    const old = document.getElementById('zeeapply-pill');
    if (old) old.remove();
    const pill = document.createElement('div');
    pill.id = 'zeeapply-pill';
    pill.textContent = text;
    Object.assign(pill.style, {
      position: 'fixed', bottom: '20px', right: '20px', zIndex: '2147483647',
      background: '#0d0d0d', color: '#ededed', padding: '12px 16px',
      borderRadius: '10px', border: '1px solid #4ade80',
      font: '14px/1.4 system-ui,sans-serif', boxShadow: '0 8px 24px rgba(0,0,0,.5)',
      maxWidth: '360px',
    });
    document.body.appendChild(pill);
    setTimeout(() => pill.remove(), 8000);
  }

  // ─── Listen for popup messages ─────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'zeeapply:fill') {
      const result = fillForm(msg.profile || {}, msg.coverLetter || '');
      sendResponse(result);
      return true;
    }
  });
})();
