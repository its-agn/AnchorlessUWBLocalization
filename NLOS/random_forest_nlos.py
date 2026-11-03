"""Simple Random Forest classifier for UWB LOS vs NLOS.

Loads every data/uwb_dataset_part*.csv file, trains a Random Forest on the
per-measurement diagnostic features, and reports accuracy on a held-out test set.

Usage:
    python NLOS/random_forest_nlos.py            # diagnostic features only
    python NLOS/random_forest_nlos.py --use-cir  # also include the raw CIR samples
"""

import argparse
import glob
import os

import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix
from sklearn.model_selection import train_test_split

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(REPO_ROOT, "data")

LABEL = "NLOS"  # 1 = NLOS, 0 = LOS


def load_data(data_dir: str) -> pd.DataFrame:
    files = sorted(glob.glob(os.path.join(data_dir, "uwb_dataset_part*.csv")))
    if not files:
        raise FileNotFoundError(f"No uwb_dataset_part*.csv files found in {data_dir}")
    print(f"Loading {len(files)} CSV files from {data_dir}")
    return pd.concat((pd.read_csv(f) for f in files), ignore_index=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data-dir", default=DATA_DIR)
    parser.add_argument("--use-cir", action="store_true", help="include the raw CIR0..CIRn columns as features")
    parser.add_argument("--n-estimators", type=int, default=200)
    parser.add_argument("--test-size", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    df = load_data(args.data_dir)
    print(f"Samples: {len(df)}  |  LOS: {(df[LABEL] == 0).sum()}  NLOS: {(df[LABEL] == 1).sum()}")

    # CIR_PWR is a diagnostic value, not a raw CIR sample, so always keep it.
    feature_cols = [
        c for c in df.columns
        if c != LABEL and (args.use_cir or not c.startswith("CIR") or c == "CIR_PWR")
    ]

    X = df[feature_cols]
    y = df[LABEL].astype(int)

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=args.test_size, random_state=args.seed, stratify=y
    )

    model = RandomForestClassifier(n_estimators=args.n_estimators, random_state=args.seed, n_jobs=-1)
    model.fit(X_train, y_train)
    y_pred = model.predict(X_test)

    print(f"\nFeatures used: {len(feature_cols)}")
    print(f"Test accuracy: {accuracy_score(y_test, y_pred):.4f}\n")
    print(classification_report(y_test, y_pred, target_names=["LOS", "NLOS"], digits=4))
    print("Confusion matrix (rows = true, cols = predicted) [LOS, NLOS]:")
    print(confusion_matrix(y_test, y_pred))

    importances = pd.Series(model.feature_importances_, index=feature_cols).sort_values(ascending=False)
    print("\nTop 10 feature importances:")
    print(importances.head(10).to_string())


if __name__ == "__main__":
    main()
