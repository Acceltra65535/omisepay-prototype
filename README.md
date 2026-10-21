# Omise SG Credit Card Payment — Minimal Implementation

A clean, lightweight, and fully functional implementation of credit card payments using the [Omise](https://www.omise.co/) Singapore payment gateway.

## Overview

This repository demonstrates a minimal, end-to-end integration for processing credit card transactions via Omise SG. It cuts through unnecessary boilerplate to focus strictly on the essential flow:
- Client-side card tokenization (`omise.js`)
- Server-side charge creation via Omise API
- 3-D Secure (3DS) redirection and return handling

## Features

- **Multi-Currency Support**: Native support for **SGD (S$)**, **USD ($)**, and **CAD (CA$)** via Omise Multi-Currency gateway.
- **Apple Pay & Credit Cards**: Seamless processing for Apple Pay and international Visa, Mastercard, American Express, and Discover cards.
- **3-D Secure 2.0 Ready**: Built-in automated 3DS verification and callback handling.
- **Strict International AVS & Anti-Fraud**: Verified Address Verification System (AVS) supporting US, Canada, UK, Australia, Singapore, and worldwide territories.
- **Customer & Invoice Entity**: Level 2 / Level 3 metadata passing for high-value authorization success.

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

## 📄 License

BSD 2-Clause — see [LICENSE](LICENSE).
