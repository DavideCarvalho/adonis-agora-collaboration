---
'@adonis-agora/collaboration': patch
---

`defaultResolveUser` answers 401 for a caller the app considers authenticated (authkit).

The resolver exists so that no app has to bolt a global middleware onto a hardcoded `/collaboration`
prefix: it calls `check()`/`authenticate()` itself and then reads `ctx.auth.user`. But
`@adonis-agora/authkit` resolves the user **on demand** — `check()` verifies the session and returns
`true`, and `ctx.auth.user` stays `undefined` forever, because the user only materialises when
something asks for it. So the routes 401'd, and every app hitting this wrote the same three-line
`resolveUser` calling `getUserOrFail()` by hand — the same call its own controllers make.

It now asks: after `check()`/`authenticate()`, when `auth.user` is still empty it tries `getUser()`
(absence reported by returning nothing) and then `getUserOrFail()` (absence reported by throwing).
Both steps are needed — one auth stack fills `user` as a side effect, another only answers a direct
question, and the point of this resolver is that no app has to know which one it installed.

Still fails closed, and still never 500s: a throwing `getUserOrFail()` is an absent user and a 401,
and an id that stringifies to nothing is a 401 too — an "empty" caller must never reach `authorize`,
where a blank id could match a rule.

A patch: no API changed and no app needs to do anything. A hand-written `resolveUser` keeps working
and can now be deleted.
