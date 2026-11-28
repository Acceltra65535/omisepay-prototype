# Omise SG Credit Card Payment — Minimal Implementation

A clean, lightweight, and fully functional implementation of credit card payments using the [Omise](https://www.omise.co/) Singapore payment gateway.
Minimal prototype for the Omise API
## Overview

This repository demonstrates a minimal, end-to-end integration for processing credit card transactions via Omise SG. It cuts through unnecessary boilerplate to focus strictly on the essential flow:
- Client-side card tokenization (`omise.js`)
- Server-side charge creation via Omise API
- 3-D Secure (3DS) redirection and return handling

## Features

- **Multi-Currency Support**: Support for **SGD (S$)** and **CAD (CA$)** via Omise Singapore.
- **Apple Pay & Credit Cards**: Apple Pay plus Visa and Mastercard for SGD/CAD; JCB is available for SGD.
- **3-D Secure 2.0 Ready**: Built-in automated 3DS verification and callback handling.
- **International AVS Address Checks**: Country-aware formatting and validation for cardholder billing addresses; the issuer determines the AVS result.
- **Separated Customer & Cardholder Data**: Customer, cardholder, and invoice details are sent in their appropriate Omise request fields.

## Quick Start

### 1. Prerequisites
- An active [Omise Singapore account](https://www.omise.co/)
- Public Key & Secret Key

### 2. Environment Variables
Create a `.env` file in the root directory:

\`\`\`bash
OMISE_PUBLIC_KEY=xxx
OMISE_SECRET_KEY=xxx
\`\`\`

## 📄 License

BSD 2-Clause — see [LICENSE](LICENSE).
