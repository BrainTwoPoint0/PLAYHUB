#!/bin/bash

# PLAYHUB Live Streaming - Key Generation Script
# Generates CloudFront signing key pair for signed URLs

set -e

KEY_DIR="./keys"
PRIVATE_KEY="$KEY_DIR/cloudfront-private-key.pem"
PUBLIC_KEY="$KEY_DIR/cloudfront-public-key.pem"

echo "=== PLAYHUB CloudFront Key Generation ==="
echo ""

# Create keys directory
mkdir -p "$KEY_DIR"

# Check if keys already exist
if [ -f "$PRIVATE_KEY" ]; then
    echo "WARNING: Keys already exist at $KEY_DIR"
    read -p "Do you want to regenerate them? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Keeping existing keys."
        exit 0
    fi
fi

# Generate 2048-bit RSA key pair
echo "Generating RSA key pair..."
openssl genrsa -out "$PRIVATE_KEY" 2048
openssl rsa -pubout -in "$PRIVATE_KEY" -out "$PUBLIC_KEY"

echo ""
echo "=== Keys Generated Successfully ==="
echo ""
echo "Private key: $PRIVATE_KEY"
echo "Public key:  $PUBLIC_KEY"
echo ""
echo "=== Next Steps ==="
echo ""
echo "1. Add the public key to your terraform.tfvars:"
echo ""
echo "cloudfront_public_key = <<EOF"
cat "$PUBLIC_KEY"
echo "EOF"
echo ""
echo "2. Add the private key to your .env.local (base64 encoded):"
echo ""
echo "CLOUDFRONT_PRIVATE_KEY=\"$(base64 -i "$PRIVATE_KEY" | tr -d '\n')\""
echo ""
echo "3. IMPORTANT: Keep the private key secure!"
echo "   - Do NOT commit the keys directory to git"
echo "   - Add 'keys/' to your .gitignore"
echo ""

# Add to gitignore if not present
if ! grep -q "infrastructure/keys/" ../.gitignore 2>/dev/null; then
    echo "infrastructure/keys/" >> ../.gitignore
    echo "Added 'infrastructure/keys/' to .gitignore"
fi

echo "Done!"
