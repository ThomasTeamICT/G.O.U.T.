// 'Profiel' — naam & avatarkleur, wachtwoord wijzigen en uitloggen.

import './activities.css';
import { api, ApiError } from '../api';
import { el, svgEl, icons, toast } from '../ui';
import { navigate } from '../router';
import { session, setUser } from '../main';
import type { User } from '../types';

const COLORS = ['#3d5a3c', '#b04a17', '#33586e', '#6b4a7a', '#7a6210', '#26291f'];

export function profileView(container: HTMLElement) {
  const user = session.user;
  if (!user) { navigate('/login'); return; }

  const root = el('main', { class: 'page profile-page' });
  container.append(root);
  root.append(el('h1', {}, 'Profiel'));

  /* ---------- kaart 1: gegevens ---------- */
  let selectedColor = user.avatarColor;

  const avatar = el('div', { class: 'avatar-big', style: `background:${selectedColor}` },
    initialOf(user.name));
  const ptName = el('div', { class: 'pt-name' }, user.name);

  const nameInput = el('input', { class: 'input', type: 'text', value: user.name, autocomplete: 'name' });
  nameInput.addEventListener('input', () => {
    ptName.textContent = nameInput.value.trim() || user.name;
    avatar.textContent = initialOf(nameInput.value);
  });

  const emailInput = el('input', { class: 'input', type: 'email', value: user.email, readonly: true });

  const swatchRow = el('div', { class: 'swatch-row' });
  function renderSwatches() {
    swatchRow.innerHTML = '';
    for (const c of COLORS) {
      const active = c.toLowerCase() === selectedColor.toLowerCase();
      swatchRow.append(el('button', {
        class: `swatch${active ? ' active' : ''}`, style: `background:${c}`,
        type: 'button', title: c,
        onclick: () => { selectedColor = c; avatar.style.background = c; renderSwatches(); },
      }, active ? svgEl(icons.check) : null));
    }
  }
  renderSwatches();

  const saveBtn = el('button', { class: 'btn btn-primary' }, svgEl(icons.save), 'Opslaan');
  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (name.length < 2) { toast('Geef een naam op (min. 2 tekens).', 'error'); return; }
    saveBtn.disabled = true;
    try {
      const r = await api.put<{ user: User }>('/api/auth/profile', { name, avatarColor: selectedColor });
      setUser(r.user);
      selectedColor = r.user.avatarColor;
      ptName.textContent = r.user.name;
      toast('Profiel opgeslagen.');
    } catch (e) {
      toast((e as ApiError)?.message || 'Opslaan mislukt.', 'error');
    } finally {
      saveBtn.disabled = false;
    }
  });

  root.append(el('div', { class: 'card profile-card' },
    el('div', { class: 'profile-top' },
      avatar,
      el('div', { style: 'min-width:0' },
        ptName,
        el('div', { class: 'pt-mail' }, user.email),
      ),
    ),
    el('label', { class: 'field' }, el('span', {}, 'Naam'), nameInput),
    el('label', { class: 'field field-muted' }, el('span', {}, 'E-mailadres'), emailInput),
    el('label', { class: 'field' }, el('span', {}, 'Avatarkleur'), swatchRow),
    el('div', { style: 'margin-top:1.1rem' }, saveBtn),
  ));

  /* ---------- kaart 2: wachtwoord ---------- */
  const curPass = el('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
  const newPass = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
  const confirmPass = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' });

  const pwBtn = el('button', { class: 'btn btn-primary' }, svgEl(icons.lock), 'Wachtwoord wijzigen');
  pwBtn.addEventListener('click', async () => {
    const current = curPass.value;
    const next = newPass.value;
    if (!current) { toast('Geef je huidige wachtwoord op.', 'error'); return; }
    if (next.length < 8) { toast('Nieuw wachtwoord moet minstens 8 tekens lang zijn.', 'error'); return; }
    if (next !== confirmPass.value) { toast('De nieuwe wachtwoorden komen niet overeen.', 'error'); return; }
    pwBtn.disabled = true;
    try {
      await api.put('/api/auth/profile', { currentPassword: current, newPassword: next });
      curPass.value = ''; newPass.value = ''; confirmPass.value = '';
      toast('Wachtwoord gewijzigd.');
    } catch (e) {
      toast((e as ApiError)?.message || 'Wijzigen mislukt.', 'error');
    } finally {
      pwBtn.disabled = false;
    }
  });

  root.append(el('div', { class: 'card profile-card' },
    el('h2', {}, 'Wachtwoord wijzigen'),
    el('label', { class: 'field' }, el('span', {}, 'Huidig wachtwoord'), curPass),
    el('label', { class: 'field' }, el('span', {}, 'Nieuw wachtwoord'), newPass),
    el('label', { class: 'field' }, el('span', {}, 'Bevestig nieuw wachtwoord'), confirmPass),
    el('div', { style: 'margin-top:.3rem' }, pwBtn),
  ));

  /* ---------- kaart 3: account ---------- */
  root.append(el('div', { class: 'card profile-card' },
    el('h2', {}, 'Account'),
    el('p', { class: 'profile-hint' },
      'Je bent ingelogd op dit toestel. Log uit als je klaar bent of een gedeeld toestel gebruikt.'),
    el('button', {
      class: 'btn btn-danger',
      onclick: async () => {
        try { await api.post('/api/auth/logout'); } catch { /* toch uitloggen */ }
        setUser(null);
        navigate('/login');
      },
    }, svgEl(icons.logout), 'Uitloggen'),
  ));
}

function initialOf(name: string): string {
  return (name.trim()[0] || '?').toUpperCase();
}
