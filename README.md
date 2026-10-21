# 台風モデル比較 — Web版

各気象機関の数値予報モデルの海面気圧から台風の中心を追い、
進路を同じ地図に重ねて比べるページ。静的ファイルだけで動く。

本アプリは各気象機関が公開する数値予報モデルのデータを比較・可視化するものであり、
独自の気象予報を提供するものではありません。気象庁の公式予報とは別物として扱うこと。

## 置き方

このフォルダをそのまま静的ホスティングに上げるだけ。サーバー処理は不要。

### いちばん早い方法（アカウント不要）
1. https://app.netlify.com/drop を開く
2. この `web` フォルダをブラウザにドラッグ
3. 出てきたURLを iPhone の Safari で開き、共有ボタン →「ホーム画面に追加」

### あとから更新したいなら（GitHub Pages）
1. github.com で空のリポジトリを作る（例: `typhoon-compare`）
2. このフォルダで:
   ```
   git init && git add -A && git commit -m "Web版の最初の版"
   git branch -M main
   git remote add origin https://github.com/<ユーザー名>/typhoon-compare.git
   git push -u origin main
   ```
3. リポジトリの Settings → Pages → Source を `main` / `/ (root)` にする

## 手元で見る

```
python3 -m http.server 8080
```
→ http://localhost:8080

## データの出どころ

- 台風の実況・経路・公式予報: 気象庁 https://www.jma.go.jp/bosai/typhoon/data/
- 各モデルの海面気圧: Open-Meteo https://open-meteo.com （CC BY 4.0・非商用の無料枠）
- 地図: Esri / OpenStreetMap 貢献者

いずれも CORS が開いているので、ブラウザから直接取得している。中継サーバーは不要。

## 中身

| ファイル | 役割 |
|---|---|
| `app.js` | 気象庁・Open-Meteo の取得、中心の追跡、モデル一致度 |
| `ui.js` | 地図、スライダー、パネルの描画 |
| `style.css` | 配色（明暗どちらにも対応） |
| `index.html` | 画面の骨組み |
| `manifest.webmanifest` | ホーム画面に追加したときの見え方 |

## 追跡で気をつけている点

- Open-Meteo の時刻の並びは当日 00Z 起点。気象庁の解析時刻に合わせないと進路が時間方向にずれる
- 日付変更線をまたぐと経度が180度を超えて配信元に拒まれるため、-180〜180 に直す
- 気象庁の実況は温帯低気圧化後に更新が止まる。そのぶん進行方向へ延ばしてから探し始める
- 格子の値そのままだと全モデルが同じ升目に吸い付くので、放物線あてはめで細かく出す
- 5回続けて要求すると Open-Meteo の毎分の上限に当たるため、3秒・10秒・20秒と待って繰り返す

## まだ入れていない（iOS版にはある）

アンサンブル予報、予報の振り返り、地点ごとの風と雨、通知、気象庁の予報円。
