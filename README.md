# FX毎朝5時間足テクニカル分析

対象はZAR/JPY（みんなのFX）とUSD/JPY（GMOクリック証券）の公開為替市場データのみです。取引口座にはログインせず、建玉・資金・維持率は取得しません。

## 自動実行と初回検証
- GitHub Actionsで毎朝07:07（Asia/Tokyo）に取得し、15分足・1時間足・4時間足・日足と日足から集計した週足を計算します。
- 初回のpushではFX_QUICK_CHECK=1の短期データ接続試験を実施します。Actionsからproductionで手動起動すれば全期間を試します。
- 取得した実際のBid OHLCに限り、左右2本で確定したスイング高安値、ダウ、支持抵抗、RSI14、MACD12/26/9を計算します。
- 結果を reports/latest.md と reports/latest.json に記録します。取得できない場合は推測しません。
- GitHub Actionsの定時起動には遅延があり得ます。データの更新日時と最新確定足の時刻を確認してください。

## 制限
- 市場データの取得結果は取引業者のBid/Askやスワップとは一致しない場合があります。
- 週足はUTC月曜で集計し形成中の足を除外します。国内FX会社の時間足区切りとは異なる場合があります。
- Publicリポジトリに口座情報・取引履歴・認証キー・秘密情報を保存しないでください。
- 既存のChatGPT朝8時タスクがこのGitHubレポートを自動で読み取る連携はまだ未検証です。テスト成功後に別途連携と時刻照合が必要です。
- GitHub Actionsのスケジュールは無活動などで無効になる可能性があります。

## 手元での実行
Node.js 20以降で npm install、npm test、npm run analyze を実行します。短期接続検証は FX_QUICK_CHECK=1 npm run analyze です。

データ取得元: https://www.dukascopy-node.app/config/node
GitHub Actions仕様: https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
