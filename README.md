# Budget Tracker

A personal budget tracker that runs entirely in your browser. There's no server, no sign-up and no paid service: open `index.html` and start planning.

## Features

- **Dashboard:** this month's income, spending, net savings and how much budget is left. It also has a spending-by-category donut chart, budget progress bars, a six-month income vs. spending chart, upcoming scheduled payments and recent transactions.
- **Transactions:** add expenses and income with a category, date and note. You can search, filter by type or category, edit, delete and export to CSV.
- **Budgets:** enter your expected monthly income and give each category a monthly limit. The app shows how much is still unallocated, and the dashboard warns you when a category reaches 80% or goes over its limit.
- **Scheduled:** set up recurring rent, bills, subscriptions or salary (weekly, every 2 weeks, monthly or yearly, with an optional end date). Each item becomes a transaction automatically on its due date. You can pause and resume them, and the app lists what's coming up in the next 30 days.
- **Goals:** create savings goals with a target and an optional deadline. The app tells you how much to save each month to hit it.
- **Settings:** choose a currency, download or restore a JSON backup, export all transactions to CSV, load sample data or reset everything.
- Light and dark mode follow your system, and the layout works on phones.

## Running it

Open `index.html` in any modern browser. To serve it locally instead:

```sh
python3 -m http.server 8000
# then visit http://localhost:8000
```

It can also be hosted for free as a static site, for example with GitHub Pages: in the repository go to Settings → Pages and deploy from the `main` branch.

## Installing on iPhone

Once the app is hosted at an `https://` address (for example GitHub Pages), you can install it:

1. Open the address in **Safari** on your iPhone.
2. Tap the **Share** button, then **Add to Home Screen**, then **Add**.

The app gets its own icon, opens full screen and works offline. Android users can do the same from Chrome's menu ("Install app").

## Your data

Everything is saved in your browser's `localStorage` on the device you use, so nothing is sent anywhere. Clearing your browser data erases it, so use **Settings → Download backup** regularly. You can also restore that file on another device.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page layout and navigation |
| `styles.css` | Styling, including dark mode and the phone layout |
| `app.js` | All app logic: storage, schedules, calculations, views and forms |
