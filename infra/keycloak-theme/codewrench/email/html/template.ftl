<#-- CodeWrench: one wrapper for every HTML email. Email clients ignore external CSS and Keycloak's
     sanitizer strips style attributes from message text, so the paragraph and link styles are added
     here, to the sanitized body, as inline styles. Palette matches login/resources/css/pages.css. -->
<#macro emailLayout>
<#assign cwBody><#nested></#assign>
<#assign cwParagraph = 'style="margin:0 0 16px 0;"'>
<#assign cwButton = 'style="display:inline-block;background-color:#18181b;color:#ffffff;text-decoration:none;font-weight:600;font-size:15px;line-height:20px;padding:14px 24px;border-radius:10px;"'>
<!DOCTYPE html>
<html lang="${locale.language}" dir="${(ltr)?then('ltr','rtl')}">
<head>
    <meta charset="utf-8">
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>CodeWrench</title>
</head>
<body style="margin:0;padding:0;background-color:#fcfcfc;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fcfcfc;">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background-color:#ffffff;border:1px solid #e4e4e7;border-radius:14px;">
        <tr>
          <td style="padding:32px 32px 0 32px;font-family:'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:16px;line-height:24px;font-weight:600;letter-spacing:-0.01em;color:#27272a;">
            CodeWrench
          </td>
        </tr>
        <tr>
          <td style="padding:24px 32px 32px 32px;font-family:'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:24px;color:#27272a;">
            ${cwBody?markup_string?replace('<p>', '<p ' + cwParagraph + '>')?replace('<a ', '<a ' + cwButton + ' ')?no_esc}
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px;border-top:1px solid #e4e4e7;font-family:'Geist',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:12px;line-height:18px;color:#71717a;">
            ${msg("cwEmailFooter")}
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>
</#macro>
