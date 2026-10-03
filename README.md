# Omise SG Credit Card Payment — Minimal Implementation

A clean, lightweight, and fully functional implementation of credit card payments using the [Omise](https://www.omise.co/) Singapore payment gateway.

## Overview

This repository demonstrates a minimal, end-to-end integration for processing credit card transactions via Omise SG. It cuts through unnecessary boilerplate to focus strictly on the essential flow:
- Client-side card tokenization (`omise.js`)
- Server-side charge creation via Omise API
- 3-D Secure (3DS) redirection and return handling

## Features

- **Minimalist & Zero Fluff**: Pure, focused implementation of the core payment flow.
- **End-to-End**: Covers the entire lifecycle from card input to verified charge.
- **3-D Secure Ready**: Built-in support for mandatory 3DS verification flows in Singapore.
- **Easy to Adapt**: Designed as a clear reference to drop into any backend/frontend stack.

## Quick Start

### 1. Prerequisites
- An active [Omise Singapore account](https://www.omise.co/)
- Public Key (`pkey_...`) & Secret Key (`skey_...`)

### 2. Environment Variables
Create a `.env` file in the root directory:

\`\`\`bash
OMISE_PUBLIC_KEY=pkey_test_xxx
OMISE_SECRET_KEY=skey_test_xxx
\`\`\`

### 3. Run Locally
\`\`\`bash
# Install dependencies
npm install  # or pip install, go run, etc.

# Start the application
npm start
\`\`\`
