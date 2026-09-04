# Orders API

This document describes the public GraphQL API for placing and managing orders.

## Users

Every customer has a `User` account. A user always has an `email`, which is required. The `name` field is optional.

The `legacyId` field on `User` is deprecated. Clients should use `id` instead.

## Orders

There is an `Order` type representing a single purchase. Each order has a `status` field and a `total` which is a `Money` value.

The `placedAt` field on `Order` is a `DateTime`.

An order's `shippingAddress` is optional at the schema level because it is populated after payment.

### Order status

The `OrderStatus` enum includes `PENDING`, `PAID`, `SHIPPED`, `DELIVERED` and `CANCELLED`.

## Querying orders

The `orders` query returns a paginated connection. It accepts `first`, `after` and `status` arguments.

## Mutations

Clients place an order with the `placeOrder` mutation and cancel one with `cancelOrder`.
