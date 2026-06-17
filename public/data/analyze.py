import json
import pandas as pd
from sklearn.ensemble import IsolationForest
from fuzzywuzzy import fuzz      # install fuzzywuzzy, python-Levenshtein

def handler(request):
    body = request.get_json()
    if not body or 'data' not in body:
        return {"error": "Missing 'data'"}, 400

    df = pd.DataFrame(body['data'])
    results = {}

    # ---- 1. Anomaly detection on numeric columns ----
    numeric_cols = df.select_dtypes(include=['number']).columns.tolist()
    if numeric_cols:
        model = IsolationForest(contamination=0.05, random_state=42)
        df['anomaly'] = model.fit_predict(df[numeric_cols])
        anomalies = df[df['anomaly'] == -1].to_dict(orient='records')
        results['anomalies'] = anomalies
        results['anomaly_count'] = len(anomalies)
        # Summary stats
        results['summary'] = {col: { "mean": float(df[col].mean()), "std": float(df[col].std()) } for col in numeric_cols}

    # ---- 2. Duplicate detection on text columns ----
    text_cols = df.select_dtypes(include=['object', 'string']).columns.tolist()
    if text_cols:
        duplicates = []
        # Compare each row with every other (simplified; for large data use dedupe library)
        for i in range(len(df)):
            for j in range(i+1, len(df)):
                # Compute fuzzy ratio for each text column, average
                ratios = []
                for col in text_cols:
                    a = str(df.iloc[i][col])
                    b = str(df.iloc[j][col])
                    ratios.append(fuzz.ratio(a, b))
                avg = sum(ratios) / len(ratios) if ratios else 0
                if avg > 80:  # threshold
                    duplicates.append({
                        "row1": df.iloc[i].to_dict(),
                        "row2": df.iloc[j].to_dict(),
                        "similarity": avg
                    })
        results['duplicates'] = duplicates
        results['duplicate_count'] = len(duplicates)

    return results, 200
