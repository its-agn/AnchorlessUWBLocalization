"""Generate the figures and numbers used in NLOS/Results.md.

Trains the same Random Forest as random_forest_nlos.py (same features, split and
seed), then writes figures to NLOS/figures/ and a metrics summary to
NLOS/figures/metrics.json.

Usage:
    python NLOS/make_results.py
"""

import json
import os

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib.colors import to_rgb
from sklearn.ensemble import RandomForestClassifier
from sklearn.inspection import partial_dependence, permutation_importance
from sklearn.metrics import accuracy_score, classification_report, confusion_matrix, roc_auc_score
from sklearn.model_selection import cross_val_score, train_test_split
from sklearn.tree import plot_tree

from random_forest_nlos import DATA_DIR, LABEL, load_data

HERE = os.path.dirname(os.path.abspath(__file__))
FIG_DIR = os.path.join(HERE, "figures")
SEED = 42
N_ESTIMATORS = 200

# Palette: categorical slots 1 and 2 of the validated default palette.
LOS_COLOR = "#2a78d6"   # blue
NLOS_COLOR = "#eb6834"  # orange
SURFACE = "#fcfcfb"
INK = "#0b0b0b"
INK_2 = "#52514e"
GRID = "#e4e3df"

plt.rcParams.update({
    "figure.facecolor": SURFACE,
    "axes.facecolor": SURFACE,
    "axes.edgecolor": GRID,
    "axes.labelcolor": INK_2,
    "axes.titlecolor": INK,
    "axes.titlesize": 12,
    "axes.titleweight": "bold",
    "axes.titlelocation": "left",
    "xtick.color": INK_2,
    "ytick.color": INK_2,
    "font.size": 10,
    "axes.spines.top": False,
    "axes.spines.right": False,
})


def save(fig, name):
    path = os.path.join(FIG_DIR, name)
    fig.savefig(path, dpi=150, bbox_inches="tight")
    plt.close(fig)
    print(f"wrote {path}")


def blend(hex_color, amount):
    """Mix a color with the surface; amount=1 is full color, 0 is surface."""
    c, s = np.array(to_rgb(hex_color)), np.array(to_rgb(SURFACE))
    return tuple(s + (c - s) * amount)


def plot_importance(imp: pd.Series, perm: pd.Series):
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.8), sharey=True)
    order = imp.sort_values().index
    for ax, series, title, xlabel in [
        (axes[0], imp, "Gini importance", "Mean decrease in impurity"),
        (axes[1], perm, "Permutation importance (test set)", "Drop in accuracy when shuffled"),
    ]:
        vals = series.reindex(order)
        ax.barh(order, vals, color=LOS_COLOR, height=0.6)
        for y, v in enumerate(vals):
            ax.text(v, y, f" {v:.3f}", va="center", fontsize=8.5, color=INK_2)
        ax.set_title(title)
        ax.set_xlabel(xlabel)
        ax.xaxis.grid(True, color=GRID, linewidth=0.8)
        ax.set_axisbelow(True)
        ax.set_xlim(0, vals.max() * 1.18)
    fig.suptitle("Which features the Random Forest relies on", x=0.01, ha="left", fontweight="bold", color=INK)
    fig.tight_layout()
    save(fig, "feature_importance.png")


def plot_direction(effect: pd.Series):
    order = effect.reindex(effect.abs().sort_values().index)
    colors = [NLOS_COLOR if v > 0 else LOS_COLOR for v in order]
    fig, ax = plt.subplots(figsize=(8, 5))
    ax.barh(order.index, order.values, color=colors, height=0.6)
    ax.axvline(0, color=INK_2, linewidth=1)
    for y, v in enumerate(order.values):
        ax.text(v, y, f" {v:+.2f} " if v > 0 else f" {v:+.2f} ", va="center",
                ha="left" if v > 0 else "right", fontsize=8.5, color=INK_2)
    lim = np.abs(order.values).max() * 1.25
    ax.set_xlim(-lim, lim)
    ax.xaxis.grid(True, color=GRID, linewidth=0.8)
    ax.set_axisbelow(True)
    ax.set_xlabel("Standardized mean difference, NLOS minus LOS (Cohen's d)")
    ax.set_title("Which way each feature pushes the prediction")
    ax.text(lim * 0.97, -0.9, "higher in NLOS  →", ha="right", color=INK, fontsize=9)
    ax.text(-lim * 0.97, -0.9, "←  higher in LOS", ha="left", color=INK, fontsize=9)
    ax.set_ylim(-1.4, len(order) - 0.4)
    fig.tight_layout()
    save(fig, "feature_direction.png")


def plot_pdp(model, X_ref: pd.DataFrame, features):
    fig, axes = plt.subplots(2, 2, figsize=(10, 7))
    for ax, feat in zip(axes.ravel(), features):
        pd_res = partial_dependence(model, X_ref, [feat], kind="average", grid_resolution=40,
                                    percentiles=(0.02, 0.98))
        grid = pd_res["grid_values"][0]
        avg = pd_res["average"][0]
        ax.axhspan(0.5, 1.0, color=blend(NLOS_COLOR, 0.08), linewidth=0)
        ax.axhspan(0.0, 0.5, color=blend(LOS_COLOR, 0.08), linewidth=0)
        ax.axhline(0.5, color=INK_2, linewidth=0.8, linestyle="--")
        ax.plot(grid, avg, color=INK, linewidth=2)
        ax.set_ylim(0, 1)
        ax.set_title(feat)
        ax.set_ylabel("Avg. predicted P(NLOS)")
        ax.yaxis.grid(True, color=GRID, linewidth=0.8)
        ax.set_axisbelow(True)
        ax.text(0.99, 0.96, "NLOS side", transform=ax.transAxes, ha="right", va="top", fontsize=8, color=INK_2)
        ax.text(0.99, 0.04, "LOS side", transform=ax.transAxes, ha="right", va="bottom", fontsize=8, color=INK_2)
    fig.suptitle("Partial dependence: how P(NLOS) changes as one feature varies",
                 x=0.01, ha="left", fontweight="bold", color=INK)
    fig.tight_layout()
    save(fig, "partial_dependence.png")


def plot_one_tree(model, feature_names, depth=3):
    est = model.estimators_[0]
    fig, ax = plt.subplots(figsize=(20, 8))
    annotations = plot_tree(est, max_depth=depth, feature_names=feature_names, class_names=["LOS", "NLOS"],
                            filled=False, proportion=True, impurity=True, rounded=True, precision=2,
                            fontsize=9, ax=ax)
    for ann in annotations:
        text = ann.get_text()
        patch = ann.get_bbox_patch()
        if patch is None:
            continue
        if "value = [" in text:
            vals = text.split("value = [")[1].split("]")[0].split(",")
            p_los, p_nlos = float(vals[0]), float(vals[1])
            color = NLOS_COLOR if p_nlos > p_los else LOS_COLOR
            purity = (max(p_los, p_nlos) - 0.5) * 2  # 0 = 50/50, 1 = pure
            if abs(p_nlos - p_los) < 0.01:  # tie: neither class
                patch.set_facecolor("#f0efec")
                patch.set_edgecolor(INK_2)
            else:
                patch.set_facecolor(blend(color, 0.12 + 0.6 * purity))
                patch.set_edgecolor(color)
        else:  # the "(...)" truncated-subtree markers
            patch.set_facecolor(SURFACE)
            patch.set_edgecolor(GRID)
    ax.set_title(f"Tree #1 of {len(model.estimators_)}, first {depth} levels "
                 f"(full tree depth {est.get_depth()}, {est.tree_.node_count} nodes)\n"
                 "blue = leans LOS, orange = leans NLOS, darker = purer node", fontsize=12)
    save(fig, "tree_example.png")


def main():
    os.makedirs(FIG_DIR, exist_ok=True)
    df = load_data(DATA_DIR)
    feature_cols = [c for c in df.columns if c != LABEL and (not c.startswith("CIR") or c == "CIR_PWR")]
    X, y = df[feature_cols], df[LABEL].astype(int)
    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=SEED, stratify=y)

    model = RandomForestClassifier(n_estimators=N_ESTIMATORS, random_state=SEED, n_jobs=-1)
    model.fit(X_train, y_train)
    y_pred = model.predict(X_test)
    y_prob = model.predict_proba(X_test)[:, 1]

    cv = cross_val_score(RandomForestClassifier(n_estimators=N_ESTIMATORS, random_state=SEED, n_jobs=-1),
                         X, y, cv=5, scoring="accuracy", n_jobs=1)

    imp = pd.Series(model.feature_importances_, index=feature_cols)
    perm_res = permutation_importance(model, X_test, y_test, n_repeats=5, random_state=SEED, n_jobs=-1)
    perm = pd.Series(perm_res.importances_mean, index=feature_cols)

    # Direction: Cohen's d (NLOS - LOS) per feature; constant features get 0.
    los, nlos = X[y == 0], X[y == 1]
    pooled = np.sqrt((los.var() + nlos.var()) / 2).replace(0, np.nan)
    effect = ((nlos.mean() - los.mean()) / pooled).fillna(0.0)

    top4 = imp.sort_values(ascending=False).index[:4].tolist()

    plot_importance(imp, perm)
    plot_direction(effect)
    plot_pdp(model, X_test.sample(2000, random_state=SEED), top4)
    plot_one_tree(model, feature_cols)

    depths = [e.get_depth() for e in model.estimators_]
    nodes = [e.tree_.node_count for e in model.estimators_]
    leaves = [e.get_n_leaves() for e in model.estimators_]
    report = classification_report(y_test, y_pred, target_names=["LOS", "NLOS"], output_dict=True)

    metrics = {
        "n_samples": int(len(df)), "n_los": int((y == 0).sum()), "n_nlos": int((y == 1).sum()),
        "n_train": int(len(X_train)), "n_test": int(len(X_test)),
        "features": feature_cols,
        "constant_features": [c for c in feature_cols if X[c].nunique() == 1],
        "test_accuracy": accuracy_score(y_test, y_pred),
        "test_roc_auc": roc_auc_score(y_test, y_prob),
        "cv5_accuracy_mean": float(cv.mean()), "cv5_accuracy_std": float(cv.std()),
        "classification_report": report,
        "confusion_matrix": confusion_matrix(y_test, y_pred).tolist(),
        "gini_importance": imp.sort_values(ascending=False).round(4).to_dict(),
        "permutation_importance": perm.sort_values(ascending=False).round(4).to_dict(),
        "cohens_d_nlos_minus_los": effect.round(3).to_dict(),
        "median_los": los.median().round(2).to_dict(),
        "median_nlos": nlos.median().round(2).to_dict(),
        "tree_depth": {"min": min(depths), "mean": float(np.mean(depths)), "max": max(depths)},
        "tree_nodes_mean": float(np.mean(nodes)),
        "tree_leaves_mean": float(np.mean(leaves)),
        "tree0_root": {"feature": feature_cols[model.estimators_[0].tree_.feature[0]],
                       "threshold": float(model.estimators_[0].tree_.threshold[0])},
    }
    with open(os.path.join(FIG_DIR, "metrics.json"), "w") as f:
        json.dump(metrics, f, indent=2)
    print(json.dumps({k: v for k, v in metrics.items() if k != "classification_report"}, indent=2))


if __name__ == "__main__":
    main()
