# PDF & Image Text Extractor / pdf-image-text-extractor

---

## Overview

Upload an image or PDF and automatically recognize and extract the text within. Recognition runs on DeepChat's built-in `read` tool with the locally configured vision model, and PDF text layers are parsed locally. Supports scanned-PDF recognition, table extraction, and batch directory processing with clean Markdown output.

**Core Value**

- **Zero external dependencies**: No third-party OCR or auth service, no API key required—ready to use out of the box.
- **Local model recognition**: Images and scanned pages are analyzed by the locally configured vision model; data stays local.
- **Format preservation**: Paragraph structure and heading hierarchy are retained wherever possible, so results are ready to use.
- **Batch processing**: Pass in a directory path to process all PDF and image files inside in one go.

---

## Features

- **Image text extraction**: The built-in `read` tool calls the local vision model to recognize all text in an image.
- **PDF text extraction**: The built-in PDF parser extracts text layers locally, page by page.
- **Scanned-PDF recognition**: Automatically detects text-less scanned pages, renders them as high-resolution images with a local script (pymupdf, no network), and recognizes them with the vision model.
- **Table extraction**: Reorganizes table data from PDFs into Markdown tables.
- **Batch directory processing**: Pass in a directory path to process all PDF and image files inside in one go.
- **Structured output**: Results are presented in clean Markdown format for easy copying or exporting.

---

## Prerequisites

- **Image / scanned-page recognition**: The current session model must support vision, or a vision model must be configured in Agent settings.
- **Scanned-PDF rendering (optional)**: Only needed for scanned PDFs: `pip install pymupdf` (a purely local Python library, no network requests).
- No API key required.

---

## Usage Guide

Just describe what you need in natural language.

| Intent                  | Example prompt                                  | Result                                            |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------- |
| Extract image text      | Upload an image, then say "extract the text"    | Recognizes and outputs all text in the image      |
| Extract PDF text        | Upload a PDF, then say "convert this PDF"       | Parses all pages, preserving paragraph structure  |
| Scanned-PDF recognition | Say "recognize the text in this scan"           | Renders scanned pages and recognizes them with AI |
| Extract tables          | "Extract the tables from this PDF"              | Structured Markdown tables, ready to paste        |
| Batch processing        | "Extract text from every file in this folder"   | Processes all PDFs and images in one go           |
| Save results            | "Save the extraction result"                    | Generates a Markdown file for later use           |

---

## Use Cases

| Scenario             | Example prompt                                 | Benefit                                        |
| -------------------- | ---------------------------------------------- | ---------------------------------------------- |
| Document digitizing  | "Convert this contract PDF to text"            | No more manual retyping                        |
| Scanned documents    | "Recognize the text in this scan"              | No OCR software needed—local vision model      |
| Table extraction     | "Pull the tables out of this report PDF"       | Markdown tables ready for further processing   |
| Archiving            | "Extract text from all files in this folder"   | Whole directory in one pass                    |
| Academic reading     | "Extract the content of this paper PDF"        | Easier note-taking, citation, and search       |
