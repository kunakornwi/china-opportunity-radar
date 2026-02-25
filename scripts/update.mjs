name: Update Opportunity Radar

on:
  schedule:
    - cron: "15 * * * *"
  workflow_dispatch:

permissions:
  contents: write

jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: "20"

      - name: Install deps
        run: |
          npm init -y
          npm i rss-parser

      - name: Run updater
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          OPENAI_MODEL: gpt-5-mini
        run: |
          ls -la
          ls -la scripts || true
          node scripts/update.mjs
          echo "---- radar.json preview ----"
          head -n 40 radar.json || true

      - name: Commit & push changes
        run: |
          git config user.name "radar-bot"
          git config user.email "radar-bot@users.noreply.github.com"
          git add radar.json
          git status
          git commit -m "Auto update radar" || echo "No changes"
          git push
