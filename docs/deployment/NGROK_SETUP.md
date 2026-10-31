# Probar las OG tags en local con ngrok

Discord, Twitter y Facebook **no pueden scrapear `localhost`**. Para ver el preview
card de `/profile/:username` (o `/post/:id`) sin desplegar, se expone el servidor
local con un túnel.

En dev las OG tags las inyecta el plugin de Vite; en `npm start`, `server.js`. El
deploy real se explica en [VERCEL_DEPLOYMENT.md](./VERCEL_DEPLOYMENT.md).

---

## 1. Instalar y autenticar ngrok

1. Descarga ngrok desde [ngrok.com/download](https://ngrok.com/download) y
   descomprímelo (en Windows, por ejemplo `C:\ngrok\`; añadir esa carpeta al `PATH`
   es opcional).
2. Regístrate y copia tu authtoken de
   [dashboard.ngrok.com/get-started/your-authtoken](https://dashboard.ngrok.com/get-started/your-authtoken).
3. Configúralo una sola vez:

```bash
ngrok config add-authtoken TU_TOKEN
```

---

## 2. Levantar el servidor

**Opción A — dev (lo normal para probar):**

```bash
npm run dev     # http://localhost:5173
```

**Opción B — build + servidor de producción:**

```bash
npm run build
npm start       # http://localhost:3000
```

---

## 3. Abrir el túnel

En una segunda terminal, apuntando al puerto que hayas elegido:

```bash
ngrok http 5173     # u 3000 con la opción B
```

ngrok imprime la URL pública temporal, por ejemplo
`https://a1b2c3d4.ngrok-free.app`.

---

## 4. Probar

```
https://a1b2c3d4.ngrok-free.app/profile/tuusuario
```

Pégalo en Discord y espera unos segundos: el crawler pedirá la página, recibirá las
OG tags y mostrará avatar/banner, `@username`, bio y título.

Para depurar sin Discord:

- [opengraph.xyz](https://www.opengraph.xyz/) — cómo se ve el preview
- [Facebook Sharing Debugger](https://developers.facebook.com/tools/debug/)
- [Twitter Card Validator](https://cards-dev.twitter.com/validator)

---

## Notas

- La URL del túnel **cambia** en cada reinicio (salvo plan pago), así que puede
  quedar cacheada la anterior en Discord.
- Mientras el túnel esté abierto, cualquiera con la URL llega a tu servidor local.
  Ciérralo con `Ctrl+C` al terminar.
- Si el preview no se actualiza, fuerza un re-scrape en el debugger correspondiente.

---

## Troubleshooting

| Problema | Solución |
|---|---|
| `ngrok: command not found` | Usa la ruta completa o añade la carpeta al `PATH` |
| Solo se ve la URL plana | El servidor local no está corriendo, o el túnel apunta a otro puerto |
| `authentication failed` | Vuelve a ejecutar `ngrok config add-authtoken` |
| El preview no aparece | Espera unos segundos, recarga el mensaje y revisa que `/profile/:username` responda HTML |
