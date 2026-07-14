# פריסה ל-Render

הפרויקט הזה הוא שרת Node, ולכן ב-Render צריך ליצור Web Service.

## 1. לפני שמעלים ל-GitHub

לא מעלים קבצי סודות:

- `work/google-service-account.json`
- `work/.env.local`
- `work/.env.local.txt`
- כל קובץ שמכיל Stripe key

הקבצים האלה כבר נמצאים ב-`.gitignore`.

## 2. העלאה ל-GitHub

להעלות את כל התיקייה הזו ל-repository פרטי או ציבורי ב-GitHub.

קבצים חשובים שחייבים לעלות:

- `package.json`
- `work/sheets-lookup-server.js`
- `RENDER_DEPLOY.md`
- `.gitignore`

## 3. יצירת Web Service ב-Render

1. להיכנס ל-Render.
2. ללחוץ `New`.
3. לבחור `Web Service`.
4. לחבר את ה-repository מ-GitHub.
5. לבחור את הפרויקט.

הגדרות:

- Runtime: `Node`
- Build Command: `npm install`
- Start Command: `npm start`

## 4. Environment Variables

במסך ה-Environment של השירות ב-Render להגדיר:

```text
SPREADSHEET_ID=1FsYu89kSbnJNEcWLDHo3oEvuolf-EMvWrmZMpd03u64
SHEET_NAME=הסדר תשלומים
STRIPE_SECRET_KEY=...
```

## 5. Google service account

יש שתי אפשרויות. עדיף להשתמש ב-Secret File.

### אפשרות מומלצת: Secret File

ב-Render ליצור Secret File:

- File name: `google-service-account.json`
- Content: כל התוכן של `work/google-service-account.json`

ואז להוסיף Environment Variable:

```text
GOOGLE_SERVICE_ACCOUNT_PATH=/etc/secrets/google-service-account.json
```

### אפשרות חלופית: Environment Variable

אפשר להגדיר:

```text
GOOGLE_SERVICE_ACCOUNT_JSON={...}
```

זה צריך להיות כל ה-JSON של service account בשורה אחת. פחות נוח, אבל הקוד תומך בזה.

## 6. הרשאות Google Sheets

לוודא שה-service account משותף על הקובץ Google Sheets בהרשאת Editor.

האימייל של ה-service account נמצא בתוך `google-service-account.json` בשדה:

```text
client_email
```

## 7. אחרי Deploy

Render ייתן כתובת כמו:

```text
https://your-service-name.onrender.com
```

זו הכתובת שאפשר לשלוח לבדיקה.

Stripe יקבל את כתובות ההצלחה והביטול לפי הדומיין של Render, כי הקוד בונה אותן לפי כתובת הבקשה.

## 8. בדיקה מהירה

אחרי הפריסה:

1. לפתוח את הכתובת של Render.
2. להזין מספר פנימי ותאריך לידה של רשומת בדיקה.
3. לוודא שהנתונים נטענים.
4. לבדוק מסלול צ׳קים או דילוג Stripe לפני ביצוע חיוב אמיתי.

