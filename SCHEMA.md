[
  {
    "name": "AX_search_product",
    "description": "Search Amazon products by query. Use cursor from a previous result to fetch the next page.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "query": {
          "minLength": 1,
          "type": "string"
        },
        "cursor": {
          "minLength": 1,
          "type": "string"
        }
      },
      "required": [
        "query"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_view_product",
    "description": "View Amazon product details, variations, selected options, and purchasable form controls by product id.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "product_id": {
          "type": "string"
        }
      },
      "required": [
        "product_id"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_update_product",
    "description": "Update Amazon product variation selections and form values before purchase.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "product_id": {
          "type": "string"
        },
        "variations": {
          "additionalProperties": true,
          "type": "object"
        },
        "form_values": {
          "additionalProperties": true,
          "type": "object"
        }
      },
      "required": [],
      "type": "object"
    }
  },
  {
    "name": "AX_add_to_cart",
    "description": "Add an Amazon product to the cart, optionally applying quantity, variations, and form values first.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "product_id": {
          "type": "string"
        },
        "quantity": {
          "minimum": 1,
          "type": "integer"
        },
        "variations": {
          "additionalProperties": true,
          "type": "object"
        },
        "form_values": {
          "additionalProperties": true,
          "type": "object"
        }
      },
      "required": [
        "product_id"
      ],
      "type": "object"
    }
  },
  {
    "name": "AX_view_cart",
    "description": "Navigate to the Amazon cart and return the current cart items.",
    "parameters": {
      "additionalProperties": false,
      "properties": {},
      "required": [],
      "type": "object"
    }
  },
  {
    "name": "AX_update_cart",
    "description": "Update the quantity of an Amazon cart item by product id. Set quantity to 0 to delete the item.",
    "parameters": {
      "additionalProperties": false,
      "properties": {
        "product_id": {
          "type": "string"
        },
        "quantity": {
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "product_id",
        "quantity"
      ],
      "type": "object"
    }
  }
]
