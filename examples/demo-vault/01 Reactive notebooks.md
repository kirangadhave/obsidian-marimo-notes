# Reactive notebooks

This notebook teaches three ideas. First, move a slider to re-run dependent cells. Second, all fences in one note form a single notebook. Third, only the active note runs. Other notes freeze.

Drag the slider below. Watch how the output below changes.

```python
import marimo as mo
slider = mo.ui.slider(1, 10, value=3)
slider
```
```marimo
import marimo as mo
slider = mo.ui.slider(1, 10, value=3)
slider
```

```python
mo.md("★" * slider.value)
```
```marimo
mo.md("★" * slider.value)
```

Every fence in this note shares one Python environment. Both fences can see the `slider` variable. When you move the slider, the second cell re-runs automatically.

Only the active note runs. Open another note, then come back here. This note restarts from the beginning. The other note you opened stays frozen on its last output. That output is a picture, not a running notebook.

For more on reactivity, see the [marimo documentation](https://docs.marimo.io).
