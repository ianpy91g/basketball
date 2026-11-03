# 投籃簿

用 iPhone 或電腦瀏覽器紀錄練投的進球、未進、待確認球數與命中率。支援相機即時計數、選擇性錄影、影片匯入、逐球回看與修正、CSV / JSON 匯出。

網頁入口：<https://ianpy91g.github.io/basketball/>

GitHub Pages 版在使用者裝置內處理相機與匯入影片，不傳送影像到伺服器。原始影片、個人筆記、分析輸出與錄影檔不包含在程式儲存庫或部署產物中。

## iPhone 使用

1. 用 Safari 開啟上方 HTTPS 網址。
2. 點「開啟後置相機」，允許網站使用相機。
3. 橫放並固定手機，清楚拍到籃圈、籃網與球的飛行路徑。
4. 點「框選籃圈」，拖曳框住橢圓形籃圈，不含籃板與籃網。
5. 想保存影片時勾選「同時錄影」，再點「開始練投」。
6. 結束後逐球複核；需要保存時匯出統計，並另按「儲存錄影」。

可使用 Safari 的「加入主畫面」建立入口。首次開啟、重新載入與取得更新需要網路；目前未提供離線快取。拍攝時保持頁面在前景，切到其他 App 或鎖定螢幕會停止分析。

統計與修正最多保存最近 10 次在目前瀏覽器的 localStorage；不會隨 GitHub 帳號同步，也不保存錄影。清除網站資料會清除這些本機統計。

## 影片分析

網頁版：切到「影片分析」，匯入 Safari / 瀏覽器能播放的 MP4 或 MOV，框選籃圈後開始。以影片播放速度在裝置內分析。能否播放取決於影片編碼與裝置支援。

MTS / M2TS 需使用電腦本機版本轉檔，GitHub Pages 不執行 Python 或 FFmpeg。

## 本機版本

需求：Python 3.10+、Node.js 18+、FFmpeg。

```powershell
python -m pip install -r requirements.txt
python server.py
```

開啟 <http://127.0.0.1:8765>，或在 Windows 雙擊 `start.cmd`。本機版本可匯入最多 2GB 的 MTS、M2TS、MP4、MOV、M4V 或 WebM，轉檔及輸出存於被 Git 排除的 `artifacts/`。

電腦的 localhost 可測試相機。iPhone 請用 GitHub Pages 的 HTTPS 網址；普通區網 HTTP 位址不能開啟 Safari 相機。

## 開發與發布

前端位於 `app/`，本機服務是 `server.py`。`app/tracker.js` 的事件規則共用於瀏覽器與本機影片分析。

```powershell
node --check app/app.js
node tests/tracker.test.cjs
node tools/build-pages.cjs
node tests/pages.test.cjs
python -m http.server 8771 --bind 127.0.0.1 --directory dist
```

`tools/build-pages.cjs` 只將明確允許的前端檔案放進 `dist/`，並啟用純瀏覽器模式。所有資源採相對路徑，支援 GitHub Pages 的專案子目錄。

推送 `main` 上的前端、建置工具、Node 測試或部署流程變更後，GitHub Actions 會自動檢查、建置與部署。也可在 Actions 的「Deploy GitHub Pages」手動執行。README 或本機 Python 服務的單獨變更不觸發網頁部署。

首次設定 Pages 時，儲存庫的 Settings → Pages → Source 應選 **GitHub Actions**。

## 辨識限制與測試

目前為固定鏡頭、單一橘褐色籃球、有籃網場景的規則原型，沒有訓練通用物件偵測模型。影片校準測試與模擬相機流程已通過；尚未完成真實 iPhone Safari 的效能與準確率驗證，也未建立跨球場的獨立測試資料集。

- 只會記錄偵測到球接近籃框的事件；畫面外、偏離籃框或被遮擋的出手可能漏算。
- 球在籃網區持續向下的軌跡作為進球線索；可見反彈或從通道外落下作為未進線索。
- 結尾、影格中斷或證據不足時保留為待確認，不直接算未進。
- 命中率分母為「進球 + 未進」，不含待確認或忽略事件。所有結果可修正，也可補記漏掉的球。
- 鏡頭晃動、球色、光線、多顆球、籃網遮擋與影格率都會影響結果。

事件規則及部署檢查可直接用 Node 執行。`tests/api_check.py` 與 `tests/browser_check.py` 是額外的本機測試，需自行提供未納入儲存庫的測試影片；`tools/prepare_test_media.py` 可從 `artifacts/source.mp4` 產生所需片段。
