// Remise à zéro du stock par l'API (appelé par stock-zero.sh) : un inventaire par magasin, chaque article
// compté à 0, puis clôture. Les écarts sont enregistrés dans le journal du stock ; rien n'est effacé.
const API = process.env.TCHOP_API ?? 'http://127.0.0.1:3000/api';
const username = process.env.TCHOP_USER;
const password = process.env.TCHOP_PASSWORD;

async function call(method, path, token, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const error = new Error(data?.message ?? `${method} ${path} : ${res.status}`);
    error.code = data?.code;
    throw error;
  }
  return data;
}

const login = await call('POST', '/auth/login', null, { username, password }).catch(() => {
  console.error('Identifiant ou mot de passe refusé (compte gérant ou propriétaire).');
  process.exit(1);
});
const token = login.accessToken;

const locations = (await call('GET', '/stock/locations', token)).filter((l) => !l.archivedAt);
let total = 0;
for (const location of locations) {
  // Un inventaire déjà ouvert sur ce magasin est repris (sinon le serveur refuse d'en ouvrir un second).
  let count;
  try {
    count = await call('POST', '/stock/inventories', token, {
      locationId: location.id,
      note: 'Remise à zéro du stock',
    });
  } catch (error) {
    if (error.code !== 'INVENTORY_IN_PROGRESS') throw error;
    const open = (await call('GET', '/stock/inventories', token)).find(
      (c) => c.status === 'open' && c.location?.id === location.id,
    );
    count = await call('GET', `/stock/inventories/${open.id}`, token);
  }
  if (count.lines.length === 0) {
    await call('POST', `/stock/inventories/${count.id}/cancel`, token, { version: count.version });
    console.log(`${location.name} : aucun article`);
    continue;
  }
  for (let i = 0; i < count.lines.length; i += 300) {
    const lines = count.lines.slice(i, i + 300).map((l) => ({ itemId: l.itemId, countedQty: 0 }));
    await call('PUT', `/stock/inventories/${count.id}/counts`, token, { lines });
  }
  const fresh = await call('GET', `/stock/inventories/${count.id}`, token);
  const closed = await call('POST', `/stock/inventories/${count.id}/close`, token, {
    version: fresh.version,
  });
  const changed = (closed.lines ?? []).filter((l) => l.varianceQty);
  total += changed.length;
  console.log(
    `${location.name} : inventaire n° ${closed.number ?? count.number} clos, ${count.lines.length} articles à 0 (${changed.length} corrigés)`,
  );
}
console.log(`Terminé : tout le stock est à zéro (${total} niveaux corrigés). Détail : Stocks, Journal.`);
