export function renderErrorPage(): string {
  return `<!doctype html>
<html lang="it">
  <head>
    <meta charset="utf-8" />
    <title>Impossibile caricare la pagina</title>
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font: 15px/1.5 -apple-system, system-ui, sans-serif; background: #000; color: #fff; display: grid; place-items: center; min-height: 100vh; margin: 0; padding: 1.5rem; }
      .card { max-width: 28rem; width: 100%; text-align: center; padding: 2rem; }
      h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
      p { color: #9ca3af; margin: 0 0 1.5rem; }
      .actions { display: flex; gap: 0.5rem; justify-content: center; flex-wrap: wrap; }
      a, button { padding: 0.5rem 1rem; border-radius: 0.375rem; font: inherit; cursor: pointer; text-decoration: none; border: 1px solid transparent; }
      .primary { background: #ffd60a; color: #000; }
      .secondary { background: #1c1c1e; color: #fff; border-color: #3a3a3c; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Impossibile caricare la pagina</h1>
      <p>Qualcosa è andato storto. Riprova oppure torna alla fotocamera.</p>
      <div class="actions">
        <button class="primary" onclick="location.reload()">Riprova</button>
        <a class="secondary" href="/">Torna alla fotocamera</a>
      </div>
    </div>
  </body>
</html>`;
}
