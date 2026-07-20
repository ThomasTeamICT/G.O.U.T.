// Inloggen & registreren.

import { api } from '../api';
import { el } from '../ui';
import { navigate } from '../router';
import { setUser } from '../main';
import type { User } from '../types';

export function authView(container: HTMLElement) {
  let mode: 'login' | 'register' = 'login';

  const wrap = el('div', { class: 'auth-wrap' });
  container.append(wrap);

  function render() {
    wrap.innerHTML = '';
    const err = el('p', { style: 'color:var(--danger);font-weight:600;min-height:1.2em;margin:.4rem 0 0;font-size:.88rem' });

    const email = el('input', { class: 'input', type: 'email', autocomplete: 'email', placeholder: 'jij@voorbeeld.be' });
    const name = el('input', { class: 'input', type: 'text', autocomplete: 'name', placeholder: 'Je naam' });
    const pass = el('input', { class: 'input', type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', placeholder: mode === 'login' ? 'Wachtwoord' : 'Kies een wachtwoord (min. 8 tekens)' });

    const submit = async (e: Event) => {
      e.preventDefault();
      err.textContent = '';
      try {
        const body: Record<string, string> = { email: email.value, password: pass.value };
        if (mode === 'register') body.name = name.value;
        const { user } = await api.post<{ user: User }>(`/api/auth/${mode}`, body);
        setUser(user);
        navigate('/routes');
      } catch (ex: any) {
        err.textContent = ex?.message || 'Er ging iets mis.';
      }
    };

    wrap.append(
      el('div', { class: 'auth-card' },
        el('div', { class: 'logo-big' },
          el('b', {}, 'G.O.U.T.'),
          el('div', {}, 'Gewoon Op Uw Tempo — routes zonder gedoe'),
        ),
        el('div', { class: 'card' },
          el('div', { class: 'tabs' },
            el('button', { class: mode === 'login' ? 'active' : '', onclick: () => { mode = 'login'; render(); } }, 'Inloggen'),
            el('button', { class: mode === 'register' ? 'active' : '', onclick: () => { mode = 'register'; render(); } }, 'Account maken'),
          ),
          el('form', { onsubmit: submit },
            el('label', { class: 'field' }, el('span', {}, 'E-mailadres'), email),
            mode === 'register' ? el('label', { class: 'field' }, el('span', {}, 'Naam'), name) : null,
            el('label', { class: 'field' }, el('span', {}, 'Wachtwoord'), pass),
            el('button', { class: 'btn btn-primary', type: 'submit', style: 'width:100%;justify-content:center' },
              mode === 'login' ? 'Inloggen' : 'Aan de slag'),
            err,
          ),
        ),
        el('div', { class: 'versie-stempel' }, `versie ${__BOUWSTEMPEL__}`),
      ),
    );
    email.focus();
  }

  render();
}
