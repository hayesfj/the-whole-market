# The Whole Market

A live look at whether the S&P still moves with the rest of the market.

The page compares the S&P (SPX) with the equal-weight S&P (SPXEW), crude oil, Treasury yields, corporate bonds, sectors, breadth, and a version of the index with the listed AI stocks removed ($SPXXAI).

Numbers are built from public prices. They are AI-assisted and may be wrong.

## Run it

```bash
npm install
npm run dev
```

The report is in `src/components/desk/desk-view.tsx`. The calculations are in `src/lib/market/compute.server.ts`.
