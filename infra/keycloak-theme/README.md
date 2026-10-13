# CodeWrench Keycloak Theme

The sign-in, sign-up, email verification and password reset pages for the `codewrench` realm.
It extends Keycloak's `keycloak.v2` login theme. `login/template.ftl` is the stock 26.7.3 template
with three marked additions (fonts, brand mark, brand panel); when the Keycloak image is upgraded,
copy the new stock template and re-apply those three. Layout and colours are in
`login/resources/css/pages.css`. Static files are cached for four hours, so rename the stylesheet
when a change must show at once.

The `codewrench` theme has three types:

- `login/`: sign-in, sign-up, verify email, reset password, error, info, sign out. `info.ftl` is the
  stock base page with a fixed Title Case heading.
- `email/`: every email Keycloak sends. `html/template.ftl` is the one shared wrapper (inline styles, text
  wordmark, no images); the wording is in `messages/messages_en.properties`.
- `account/`: the account console (`keycloak.v3`, a React app). Restyled with PatternFly variables in
  `resources/css/account.css`; logo, favicon and `darkMode=false` are in `theme.properties`.

Install by placing the `codewrench` folder in Keycloak's `themes` directory, then set the realm's
login, email and account themes to `codewrench` (realm settings > Themes, or `loginTheme`, `emailTheme`,
`accountTheme` in the realm JSON). The email and account types do nothing until their setting is switched on.

CodeWrench has its own Keycloak on the home server (`/home/candid/docker/services/codewrench-keycloak`,
public at `codewrench-login.savagesolutions.io`), separate from the Candid and Savage sign-in service.
The theme folder is mounted into it read-only, so copying a changed file there takes effect on the
next page load.
