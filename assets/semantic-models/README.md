# Bundled semantic embedding model

CodeStudio ships IBM Granite Embedding 97M Multilingual R2 as a q8 ONNX model. It uses CLS pooling, normalized 384-dimensional vectors and unprefixed text. The default chunk limit stays at 512 tokens.

- [IBM model and Apache 2.0 license](https://huggingface.co/ibm-granite/granite-embedding-97m-multilingual-r2)
- [Pinned Transformers.js ONNX conversion](https://huggingface.co/onnx-community/granite-embedding-97m-multilingual-r2-ONNX/tree/536a9f241cb3f02a9c5995a1e708c784bd274859)
- SHA-256 for `onnx/model_quantized.onnx` is `704c1ebca5fbb7cd83ced41827658ac4c9990c64f7f2874d22b78044e5022e22`.
- SHA-256 for `tokenizer.json` is `51947676cae1f991fa51c6b9a24e14ee5460e5f0b9f692f13bb3159829d1592a`.

The files are tracked directly in Git. The development runtime reads them from this directory and the desktop package includes them under `resources/semantic-models`.
