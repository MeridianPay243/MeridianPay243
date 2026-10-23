# Meridian Pay — Commercial ACH & Guest Bank Verification Portal

Commercial-standard website integrated with the **Checkbook.io v3 API** (`https://api.checkbook.io/v3`) and **Gmail SMTP** (`smtp.gmail.com:587`).

## Folder Structure (Open Directly in VS Code)

```text
netlify-app/
├── public/
│   ├── index.html                  # Official Guest Bank Verification Portal (/)
│   ├── admin.html                  # Secured Admin Console (/admin)
│   ├── logo.svg                    # Meridian Pay full company logo vector image
│   └── favicon.svg                 # Meridian Pay emerald monogram icon
├── netlify/
│   └── functions/
│       ├── api.js                  # Main REST API & Webhook router
│       └── _lib/
│           ├── checkbook.js        # Checkbook.io v3 API client (Directory, IAV, Micro-deposits, Invoices, Digital Checks)
│           ├── mailer.js           # Gmail SMTP mailer + Company Logo & Executive Memo HTML templates
│           └── store.js            # Encrypted state & configuration store
├── api/
│   └── index.js                    # Vercel serverless entry wrapper
├── server.js                       # Node.js HTTP server (for local VS Code & Render)
├── package.json                    # Dependencies (nodemailer) & start script
├── render.yaml                     # Render deployment blueprint
├── netlify.toml                    # Netlify deployment config
└── vercel.json                     # Vercel deployment config
```

## Running Locally in VS Code

1. Open the `netlify-app` folder in **Visual Studio Code**.
2. Open the VS Code Integrated Terminal (`Ctrl+\``) and run:
   ```bash
   npm install
   npm start
   ```
3. Open in your browser:
   - **Guest Bank Verification Portal:** `http://localhost:3000/`
   - **Secured Admin Console:** `http://localhost:3000/admin` (`Koaa0@hotmail.com` / `243@love`)
   - **Checkbook Webhook Receiver:** `http://localhost:3000/webhook/checkbook`

> **Note on Email Delivery:** When running locally in VS Code (`npm start`), outbound TCP port `587` (`smtp.gmail.com:587`) connects directly without cloud free-tier firewall restrictions, so all customer emails deliver in under 1 second.
